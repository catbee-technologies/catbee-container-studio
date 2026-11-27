import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { LimaEngineDriver } from '../../../../../src/main/docker/embedded/drivers/lima-engine.driver';
import { CATBEE_LIMA_INSTANCE } from '../../../../../src/main/docker/embedded/engine-paths';
import {
  ensureHostDockerCli,
  pathExists,
  runCommand,
  waitForDockerEndpoint,
  writeEngineManifest
} from '../../../../../src/main/docker/embedded/engine-utils';
import { DEFAULT_ENGINE_SETTINGS, getEngineSettings } from '../../../../../src/main/docker/embedded/engine-settings';

vi.mock('electron', () => ({}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('../../../../../src/main/docker/embedded/engine-settings', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-settings')>();
  return { ...original, getEngineSettings: vi.fn(async () => original.DEFAULT_ENGINE_SETTINGS) };
});
vi.mock('../../../../../src/main/docker/embedded/system-proxy', () => ({ detectSystemProxy: async () => null }));
vi.mock('../../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  ensureHostDockerCli: vi.fn(),
  getDockerServerVersion: vi.fn(),
  pathExists: vi.fn(),
  runCommand: vi.fn(),
  waitForDockerEndpoint: vi.fn(),
  writeEngineManifest: vi.fn()
}));

beforeEach(() => vi.resetAllMocks());

it('raises the default open file soft limit for containers in the Lima VM', async () => {
  const driver = new LimaEngineDriver();

  await expect(driver.buildDaemonConfig(DEFAULT_ENGINE_SETTINGS)).resolves.toMatchObject({
    'default-ulimits': {
      nofile: { Name: 'nofile', Soft: 82_920, Hard: 524_288 }
    }
  });
});

it('refuses to create a VM over an existing instance directory missing its configuration', async () => {
  const driver = new LimaEngineDriver();
  vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
  vi.mocked(pathExists).mockImplementation(async target => path.basename(target) === CATBEE_LIMA_INSTANCE);

  await expect(driver.install(vi.fn())).rejects.toThrow('Restore lima.yaml before reinstalling');
  expect(pathExists).toHaveBeenNthCalledWith(1, expect.stringContaining('lima.yaml'));
  expect(runCommand).not.toHaveBeenCalled();
});

it('creates the VM with forwarding disabled and verifies Docker readiness', async () => {
  const driver = new LimaEngineDriver();
  vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
  vi.mocked(getEngineSettings).mockResolvedValue({ ...DEFAULT_ENGINE_SETTINGS, forwardHostFileChanges: true });
  vi.mocked(pathExists).mockImplementation(async target => path.basename(target) === 'limactl');
  vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(waitForDockerEndpoint).mockRejectedValue(new Error('No response from Docker'));
  const progress = vi.fn();

  await expect(driver.install(progress)).rejects.toThrow('No response from Docker');
  expect(runCommand).toHaveBeenCalledWith(
    expect.stringContaining('limactl'),
    expect.arrayContaining(['create', '--mount-inotify=false']),
    expect.any(Object)
  );
  expect(runCommand).toHaveBeenCalledWith(
    expect.stringContaining('limactl'),
    expect.arrayContaining(['start']),
    expect.any(Object)
  );
  expect(waitForDockerEndpoint).toHaveBeenCalledExactlyOnceWith(driver.getRunningConnection(), 120_000);
  expect(writeEngineManifest).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalledWith(100, expect.any(String));
});

it.each([
  { applied: true, restarts: true },
  { applied: false, restarts: false },
  { applied: undefined, restarts: false }
])('forces forwarding off on an existing VM with $applied applied (restart: $restarts)', async testCase => {
  const { applied, restarts } = testCase;
  const driver = new LimaEngineDriver();
  const settings = { ...DEFAULT_ENGINE_SETTINGS, fileSharingPaths: [], forwardHostFileChanges: true };
  const { cpus, memoryGb, diskGb, rosetta } = settings.resources;
  const mounts = [path.resolve(os.homedir()), path.resolve('/var/folders')].sort((a, b) => a.length - b.length);
  vi.spyOn(driver, 'getManifest').mockResolvedValue(null);
  vi.mocked(pathExists).mockResolvedValue(true);
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({
      schemaVersion: 2,
      cpus,
      memoryGb,
      diskGb,
      mounts,
      rosetta: process.arch === 'arm64' && rosetta,
      lanPorts: true,
      networkMode: 'vznat',
      mountInotify: applied
    })
  );
  vi.mocked(ensureHostDockerCli).mockResolvedValue('docker');
  vi.mocked(runCommand).mockImplementation(async (_binary, [command]) => ({
    stdout: command === 'list' ? JSON.stringify({ name: CATBEE_LIMA_INSTANCE, status: 'Running' }) : '',
    stderr: ''
  }));

  await expect(driver.start(settings)).resolves.toEqual(driver.getRunningConnection());

  const vmCommands = vi
    .mocked(runCommand)
    .mock.calls.filter(([binary, [command]]) => path.basename(binary) === 'limactl' && command !== 'shell')
    .map(([, args]) => args);
  if (restarts) {
    expect(vmCommands.map(([command]) => command)).toEqual(['list', 'stop', 'edit', 'start']);
    expect(vmCommands[2]).toContain('--mount-inotify=false');
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('lima-vm.json'),
      expect.stringContaining('"mountInotify": false'),
      'utf8'
    );
  } else {
    expect(vmCommands.map(([command]) => command)).toEqual(['list']);
    expect(writeFile).not.toHaveBeenCalled();
  }
});
