import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerApiGetJson,
  runCommand,
  updateEngineManifest
} from '../../../../../src/main/docker/embedded/engine-utils';
import { WslEngineDriver } from '../../../../../src/main/docker/embedded/drivers/wsl-engine.driver';
import { CATBEE_WSL_DISTRO } from '../../../../../src/main/docker/embedded/engine-paths';

const { stopRelay } = vi.hoisted(() => ({ stopRelay: vi.fn(async () => {}) }));
vi.mock('electron', () => ({}));
vi.mock('../../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../../../src/main/docker/embedded/endpoint-relay', () => ({
  EndpointRelay: class {
    stop = stopRelay;
  }
}));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  runCommand: vi.fn(),
  dockerApiGetJson: vi.fn(),
  updateEngineManifest: vi.fn(),
  sleep: vi.fn()
}));

const running = CATBEE_WSL_DISTRO.split('').join('\0') + '\r\n';
const response = (stdout = '') => ({ stdout, stderr: '' });

describe('Windows WSL engine', () => {
  let driver: WslEngineDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockReset();
    vi.mocked(dockerApiGetJson).mockReset();
    driver = new WslEngineDriver();
  });

  it.each([
    ['catbee-id', 'running'],
    ['unrelated-daemon', 'stopped']
  ])('reports %s only when the host daemon ID belongs to the guest', async (id, status) => {
    vi.spyOn(driver, 'isInstalled').mockResolvedValue(true);
    vi.mocked(runCommand).mockResolvedValueOnce(response(running)).mockResolvedValueOnce(response('catbee-id\n'));
    vi.mocked(dockerApiGetJson).mockResolvedValue({ ID: id });

    await expect(driver.getStatus()).resolves.toBe(status);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.arrayContaining([expect.stringContaining('unix:///var/run/docker.sock')]),
      expect.any(Object)
    );
    expect(dockerApiGetJson).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1' }), '/info', 2_000);
  });

  it('keeps the relay open when the distro is still running after termination', async () => {
    vi.mocked(runCommand)
      .mockResolvedValueOnce(response(running))
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error('terminate failed'))
      .mockResolvedValueOnce(response(running));

    await expect(driver.stop()).rejects.toThrow('still running');
    expect(stopRelay).not.toHaveBeenCalled();
    expect(updateEngineManifest).not.toHaveBeenCalled();
  });

  it('closes the relay only after verifying that the distro stopped', async () => {
    vi.mocked(runCommand)
      .mockResolvedValueOnce(response(running))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());

    await driver.stop();
    expect(stopRelay).toHaveBeenCalledOnce();
    expect(updateEngineManifest).toHaveBeenCalledWith({ state: 'stopped' });
    expect(stopRelay.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(runCommand).mock.invocationCallOrder[3]);
  });

  it('does not pass option-shaped distro names to WSL', async () => {
    await expect(driver.configureWslDistroIntegration('--list', true)).resolves.toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
