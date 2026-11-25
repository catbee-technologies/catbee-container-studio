import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LimaEngineDriver } from '../../../../../src/main/docker/embedded/drivers/lima-engine.driver';
import { CATBEE_LIMA_INSTANCE } from '../../../../../src/main/docker/embedded/engine-paths';
import { pathExists, runCommand } from '../../../../../src/main/docker/embedded/engine-utils';

vi.mock('electron', () => ({}));
vi.mock('../../../../../src/main/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  pathExists: vi.fn(),
  runCommand: vi.fn()
}));

it('refuses to create a VM over an existing instance directory missing its configuration', async () => {
  const driver = new LimaEngineDriver();
  vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
  vi.mocked(pathExists).mockImplementation(async target => path.basename(target) === CATBEE_LIMA_INSTANCE);

  await expect(driver.install(vi.fn())).rejects.toThrow('Restore lima.yaml before reinstalling');
  expect(pathExists).toHaveBeenNthCalledWith(1, expect.stringContaining('lima.yaml'));
  expect(runCommand).not.toHaveBeenCalled();
});
