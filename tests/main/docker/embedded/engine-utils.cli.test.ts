import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DOCKER_CLI_RELEASE_VERSION } from '../../../../src/constants.docker';
import { ensureHostDockerCli, getDockerCliDownloadInfo } from '../../../../src/main/docker/embedded/engine-utils';

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
  SHELL_PROFILE_TARGETS: []
}));
vi.mock('../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

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
