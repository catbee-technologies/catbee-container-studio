import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerApiGetJson,
  ensureHostDockerCli,
  runCommand,
  updateEngineManifest,
  writeEngineManifest
} from '../../../../../src/main/docker/embedded/engine-utils';
import type { EngineManifest } from '../../../../../src/main/docker/embedded/types/manifest.types';
import { WslEngineDriver } from '../../../../../src/main/docker/embedded/drivers/wsl-engine.driver';
import { CATBEE_WSL_DISTRO } from '../../../../../src/main/docker/embedded/engine-paths';

const { stopRelay } = vi.hoisted(() => ({ stopRelay: vi.fn(async () => {}) }));
vi.mock('electron', () => ({}));
vi.mock('../../../../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../../../../src/main/docker/embedded/engine-settings', () => ({
  getEngineSettings: async () => ({ desktopProxy: { mode: 'none' } })
}));
vi.mock('../../../../../src/main/docker/embedded/system-proxy', () => ({ detectSystemProxy: async () => null }));
vi.mock('../../../../../src/main/docker/embedded/endpoint-relay', () => ({
  EndpointRelay: class {
    stop = stopRelay;
  }
}));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  runCommand: vi.fn(),
  dockerApiGetJson: vi.fn(),
  ensureHostDockerCli: vi.fn(),
  updateEngineManifest: vi.fn(),
  writeEngineManifest: vi.fn(),
  sleep: vi.fn()
}));

const running = CATBEE_WSL_DISTRO.split('').join('\0') + '\r\n';
const response = (stdout = '') => ({ stdout, stderr: '' });
const incompleteManifest: EngineManifest = {
  schemaVersion: 2,
  backend: 'wsl2',
  engineVersion: 'unknown',
  platform: 'win32',
  architecture: 'x64',
  distribution: 'alpine',
  installedAt: '2026-11-25T18:00:00.000Z',
  endpoint: { type: 'npipe', address: 'catbee' },
  state: 'stopped'
};

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
      ['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec', 'sh', '-s'],
      expect.objectContaining({ input: expect.stringContaining('unix:///var/run/docker.sock') })
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

  it('does not treat an unknown-version manifest as installed without a working dockerd', async () => {
    vi.spyOn(driver, 'getManifest').mockResolvedValue(incompleteManifest);
    vi.mocked(runCommand)
      .mockResolvedValueOnce(response(CATBEE_WSL_DISTRO))
      .mockRejectedValueOnce(new Error('dockerd not found'));

    await expect(driver.isInstalled()).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('preserves the registered distro and reports APK TLS failure instead of completing installation', async () => {
    vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
    vi.spyOn(driver, 'getManifest').mockResolvedValue({ ...incompleteManifest });
    vi.mocked(runCommand).mockImplementation(async (executable, args, options) => {
      if (executable.toLowerCase().endsWith('powershell.exe')) return response('[]');
      if (args[0] === '-l') return response(CATBEE_WSL_DISTRO);
      const script = args.at(-1) === '-s' ? (options?.input ?? '') : (args.at(-1) ?? '');
      if (script.includes('dockerd --version')) throw new Error('dockerd not found');
      if (script.includes('apk add')) {
        expect(args).toEqual(['-d', CATBEE_WSL_DISTRO, '-u', 'root', '--exec', 'sh', '-s']);
        expect(script).toMatch(/^set -e\n/);
        expect(script).toContain('SSL_CERT_FILE="$bootstrap_ca" apk add');
        expect(script).not.toContain('|| true');
        options?.onOutput?.('WARNING: fetching Alpine package index: TLS: server certificate not trusted');
        throw new Error('apk returned exit 1');
      }
      return response();
    });
    const progress = vi.fn();

    await expect(driver.install(progress)).rejects.toThrow('TLS: server certificate not trusted');
    expect(writeEngineManifest).not.toHaveBeenCalled();
    expect(ensureHostDockerCli).not.toHaveBeenCalled();
    expect(progress.mock.calls.some(([percent]) => percent === 100)).toBe(false);
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args.includes('--unregister') || args.includes('--import'))
    ).toBe(false);
  });

  it('refuses to record installation when APK exits successfully but dockerd still does not work', async () => {
    vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
    vi.spyOn(driver, 'getManifest').mockResolvedValue(null);
    vi.mocked(runCommand).mockImplementation(async (executable, args) => {
      if (executable.toLowerCase().endsWith('powershell.exe')) return response('[]');
      if (args[0] === '-l') return response(CATBEE_WSL_DISTRO);
      return response();
    });

    await expect(driver.install(vi.fn())).rejects.toThrow('dockerd is unavailable');
    expect(writeEngineManifest).not.toHaveBeenCalled();
  });
});
