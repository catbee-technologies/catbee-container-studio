import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CATBEE_WSL_DISTRO } from '../../../src/constants.docker';
import { pathExists, runCommand } from '../../../src/main/docker/embedded/engine-utils';
import { dockerManager } from '../../../src/main/docker/services/docker.manager';
import { k8sManager } from '../../../src/main/k8s/k8s-manager';

vi.mock('electron', () => ({}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), rm: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/main/docker/runtime/docker.runtime', () => ({}));
vi.mock('../../../src/main/docker/embedded/engine-paths', () => ({
  getEngineBinDir: () => 'C:/Users/CatBee Test/.catbee/bin',
  getWslEngineDiskPath: () => 'C:/Users/CatBee Test/AppData/Local/CatBee/engine/wsl/ext4.vhdx'
}));
vi.mock('../../../src/main/docker/embedded/engine-settings', () => ({
  getEngineSettings: async () => ({ kubernetes: { provisioner: 'kind', version: 'v1.37.0', nodeCount: 1 } })
}));
vi.mock('../../../src/main/docker/embedded/engine-utils', () => ({
  pathExists: vi.fn(),
  pingDockerEndpoint: async () => true,
  runCommand: vi.fn()
}));
vi.mock('../../../src/main/docker/services/docker.manager', () => ({
  dockerManager: {
    currentRuntime: { source: 'embedded', connection: { type: 'npipe', path: '//./pipe/catbee-desktop' } },
    isEmbeddedEngineReady: true,
    containers: { listContainers: async () => [] }
  }
}));

beforeEach(() => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' }, arch: { value: 'x64' } }));
  Object.assign(dockerManager, { isEmbeddedEngineReady: true });
  let savedState: string | undefined;
  vi.mocked(readFile)
    .mockReset()
    .mockImplementation(async () => {
      if (savedState === undefined) throw new Error('No saved runtime status');
      return savedState;
    });
  vi.mocked(writeFile)
    .mockReset()
    .mockImplementation(async (_file, state) => {
      savedState = String(state);
    });
  vi.mocked(pathExists).mockReset().mockResolvedValue(true);
  vi.mocked(runCommand).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('copies kind using direct WSL arguments and verifies the guest binary', async () => {
  await expect(k8sManager.installKind()).resolves.toBe('/usr/local/bin/kind');
  const prefix = ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec'];
  expect(runCommand).toHaveBeenNthCalledWith(
    1,
    'wsl.exe',
    [
      ...prefix,
      'install',
      '-D',
      '-m',
      '0755',
      '--',
      '/mnt/c/Users/CatBee Test/.catbee/bin/kind-linux-amd64',
      '/usr/local/bin/kind'
    ],
    { timeoutMs: 30_000 }
  );
  expect(runCommand).toHaveBeenNthCalledWith(2, 'wsl.exe', [...prefix, '/usr/local/bin/kind', 'version'], {
    timeoutMs: 5_000
  });
});

it('reports an install failure when the copied guest binary cannot run', async () => {
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockRejectedValue(new Error('Exec format error'));
  await expect(k8sManager.installKind()).rejects.toThrow('Failed to install kind in WSL: Exec format error');
  await expect(k8sManager.isKindInstalled()).resolves.toBe(false);
  expect(writeFile).not.toHaveBeenCalled();
});

it('remembers a verified installation without starting WSL after the engine stops', async () => {
  await k8sManager.installKind();
  Object.assign(dockerManager, { isEmbeddedEngineReady: false });
  vi.mocked(runCommand).mockClear();

  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: true });
  expect(runCommand).not.toHaveBeenCalled();
});

it.each([true, false])('remembers the result of a live kind probe (%s)', async installed => {
  vi.mocked(runCommand).mockResolvedValueOnce({ stdout: String(installed), stderr: '' });
  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'stopped', isKindInstalled: installed });
  Object.assign(dockerManager, { isEmbeddedEngineReady: false });
  vi.mocked(runCommand).mockClear();

  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: installed });
  expect(runCommand).not.toHaveBeenCalled();
});

it('does not infer a guest installation from the downloaded kind binary', async () => {
  Object.assign(dockerManager, { isEmbeddedEngineReady: false });
  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: null });
  expect(runCommand).not.toHaveBeenCalled();
});

it('keeps the verified installation when the WSL probe itself fails', async () => {
  await k8sManager.installKind();
  vi.mocked(runCommand).mockRejectedValueOnce(new Error('WSL timed out'));
  await expect(k8sManager.getStatus()).resolves.toMatchObject({ isKindInstalled: true });
  expect(writeFile).toHaveBeenCalledTimes(1);
});

it('remembers an explicit kind uninstall after the engine stops', async () => {
  await k8sManager.installKind();
  vi.spyOn(k8sManager, 'cleanKubeconfig').mockResolvedValue(undefined);
  await expect(k8sManager.uninstallRuntime()).resolves.toEqual({ success: true });
  Object.assign(dockerManager, { isEmbeddedEngineReady: false });
  vi.mocked(runCommand).mockClear();

  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: false });
  expect(runCommand).not.toHaveBeenCalled();
});

it('ignores the previous kind installation after the WSL disk is removed', async () => {
  await k8sManager.installKind();
  Object.assign(dockerManager, { isEmbeddedEngineReady: false });
  vi.mocked(pathExists).mockResolvedValue(false);
  vi.mocked(runCommand).mockClear();

  await expect(k8sManager.getStatus()).resolves.toMatchObject({ status: 'unavailable', isKindInstalled: false });
  expect(runCommand).not.toHaveBeenCalled();
});
