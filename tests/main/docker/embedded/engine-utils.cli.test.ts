import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DOCKER_CLI_RELEASE_VERSION } from '../../../../src/constants.docker';
import {
  ensureHostDockerCli,
  ensureShellPath,
  getDockerCliDownloadInfo,
  removeShellPath
} from '../../../../src/main/docker/embedded/engine-utils';

const { spawn, home, bin, downloads } = vi.hoisted(() => ({
  spawn: vi.fn(),
  home: vi.fn(),
  bin: vi.fn(),
  downloads: vi.fn()
}));
vi.mock('electron', () => ({}));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../../../../src/main/docker/embedded/engine-paths', () => ({
  getEngineBinDir: bin,
  getEngineDownloadsDir: downloads,
  homeDir: home,
  SHELL_PROFILE_TARGETS: ['.bashrc']
}));
vi.mock('../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

let directory: string;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('keeps the existing CLI after interrupted extraction and replaces it on retry', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
  directory = await mkdtemp(path.join(tmpdir(), 'catbee-host-cli-test-'));
  const binDir = path.join(directory, 'bin');
  const downloadDir = path.join(directory, 'downloads');
  const cacheDir = path.join(downloadDir, 'host-cli');
  const target = path.join(binDir, 'docker');
  home.mockReturnValue(directory);
  bin.mockReturnValue(binDir);
  downloads.mockReturnValue(downloadDir);
  await mkdir(binDir);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(target, 'existing CLI');
  const { archiveName } = getDockerCliDownloadInfo();
  await writeFile(path.join(cacheDir, archiveName), 'cached archive');
  let interrupt = true;
  spawn.mockImplementation((command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    });
    void Promise.resolve().then(async () => {
      try {
        if (command === 'tar') {
          await writeFile(path.join(args[args.indexOf('-C') + 1], 'docker'), 'new CLI');
          if (interrupt) {
            interrupt = false;
            child.stderr.write('interrupted extraction');
            child.emit('close', 1);
            return;
          }
        } else {
          const version = command === target ? '0.0.1' : DOCKER_CLI_RELEASE_VERSION;
          child.stdout.write(`Docker version ${version}\n`);
        }
        child.emit('close', 0);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  });

  const first = ensureHostDockerCli();
  expect(ensureHostDockerCli()).toBe(first);
  await expect(first).rejects.toThrow('interrupted extraction');
  expect(await readFile(target, 'utf8')).toBe('existing CLI');
  expect(await readdir(cacheDir)).toEqual([archiveName]);
  expect(await readdir(binDir)).toEqual(['docker']);

  await expect(ensureHostDockerCli()).resolves.toBe(target);
  expect(await readFile(target, 'utf8')).toBe('new CLI');
  expect(await readdir(cacheDir)).toEqual([archiveName]);
});

it('passes the Windows bin directory as data alongside each fixed PowerShell script', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
  const binDir = "C:\\Users\\O'Connor [Archive] $Data\\.catbee\\bin";
  directory = await mkdtemp(path.join(tmpdir(), 'catbee-shell-path-test-'));
  home.mockReturnValue(directory);
  bin.mockReturnValue(binDir);

  const calls: Array<{ command: string; args: string[]; options: { shell?: boolean; env?: NodeJS.ProcessEnv } }> = [];
  spawn.mockImplementation((command: string, args: string[], options: { shell?: boolean; env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    });
    void Promise.resolve().then(() => child.emit('close', 0));
    return child;
  });

  await ensureShellPath();
  await removeShellPath();

  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.command).toBe('powershell.exe');
    expect(call.options.shell).toBe(false);
    expect(call.options.env?.CATBEE_BIN_DIR).toBe(binDir);
    expect(call.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(call.args[3], 'base64').toString('utf16le');
    expect(script).toContain('$env:CATBEE_BIN_DIR');
    expect(script).not.toContain(binDir);
  }
});

it('writes a literal POSIX PATH entry and removes it without changing other profile lines', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
  directory = await mkdtemp(path.join(tmpdir(), 'catbee-shell-path-test-'));
  home.mockReturnValue(directory);
  bin.mockReturnValue("/home/O'Connor [Archive] $Data/.catbee/bin");
  const profile = path.join(directory, '.bashrc');
  await writeFile(profile, 'export EDITOR=vim\n');

  await ensureShellPath();
  const content = await readFile(profile, 'utf8');
  expect(content).toContain(String.raw`export PATH='/home/O'\''Connor [Archive] $Data/.catbee/bin':"$PATH"`);
  await ensureShellPath();
  expect(await readFile(profile, 'utf8')).toBe(content);

  await removeShellPath();
  expect((await readFile(profile, 'utf8')).trim()).toBe('export EDITOR=vim');
});
