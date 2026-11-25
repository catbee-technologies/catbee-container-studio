import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { LimaEngineDriver } from '../../../../../src/main/docker/embedded/drivers/lima-engine.driver';
import { CATBEE_LIMA_INSTANCE } from '../../../../../src/main/docker/embedded/engine-paths';
import {
  pathExists,
  runCommand,
  waitForDockerEndpoint,
  writeEngineManifest
} from '../../../../../src/main/docker/embedded/engine-utils';

vi.mock('electron', () => ({}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock('../../../../../src/main/docker/embedded/engine-settings', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-settings')>();
  return { ...original, getEngineSettings: async () => original.DEFAULT_ENGINE_SETTINGS };
});
vi.mock('../../../../../src/main/docker/embedded/system-proxy', () => ({ detectSystemProxy: async () => null }));
vi.mock('../../../../../src/main/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  pathExists: vi.fn(),
  runCommand: vi.fn(),
  waitForDockerEndpoint: vi.fn(),
  writeEngineManifest: vi.fn()
}));

beforeEach(() => vi.resetAllMocks());

it('refuses to create a VM over an existing instance directory missing its configuration', async () => {
  const driver = new LimaEngineDriver();
  vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
  vi.mocked(pathExists).mockImplementation(async target => path.basename(target) === CATBEE_LIMA_INSTANCE);

  await expect(driver.install(vi.fn())).rejects.toThrow('Restore lima.yaml before reinstalling');
  expect(pathExists).toHaveBeenNthCalledWith(1, expect.stringContaining('lima.yaml'));
  expect(runCommand).not.toHaveBeenCalled();
});

it('does not record a successful install when Lima boots but Docker never answers', async () => {
  const driver = new LimaEngineDriver();
  vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
  vi.mocked(pathExists).mockImplementation(async target => path.basename(target) === 'limactl');
  vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(waitForDockerEndpoint).mockRejectedValue(new Error('No response from Docker'));
  const progress = vi.fn();

  await expect(driver.install(progress)).rejects.toThrow('No response from Docker');
  expect(runCommand).toHaveBeenCalledWith(
    expect.stringContaining('limactl'),
    expect.arrayContaining(['start']),
    expect.any(Object)
  );
  expect(waitForDockerEndpoint).toHaveBeenCalledExactlyOnceWith(driver.getRunningConnection(), 120_000);
  expect(writeEngineManifest).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalledWith(100, expect.any(String));
});
