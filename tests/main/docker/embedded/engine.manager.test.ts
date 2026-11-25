import { afterEach, describe, expect, it, vi } from 'vitest';
import { WslEngineDriver } from '../../../../src/main/docker/embedded/drivers/wsl-engine.driver';
import { DEFAULT_ENGINE_SETTINGS } from '../../../../src/main/docker/embedded/engine-settings';
import { EngineManager } from '../../../../src/main/docker/embedded/engine.manager';

vi.mock('electron', () => ({}));
vi.mock('../../../../src/main/logger', () => ({ logger: { error: vi.fn() } }));

describe('WSL integration transactions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the installed distro name and rejects names absent from WSL’s user distro list', async () => {
    const driver = new WslEngineDriver();
    const list = vi.spyOn(driver, 'getInstalledDistros').mockResolvedValue(['Ubuntu-24.04']);
    const configure = vi.spyOn(driver, 'configureWslDistroIntegration').mockResolvedValue(true);
    const manager = new EngineManager(driver);

    await expect(manager.configureWslDistroIntegration('Unknown', true)).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();
    await expect(manager.configureWslDistroIntegration('ubuntu-24.04', true)).resolves.toBe(true);
    expect(list).toHaveBeenCalledWith(true);
    expect(configure).toHaveBeenCalledExactlyOnceWith('Ubuntu-24.04', true);
  });

  it('rolls back changes in reverse order when the settings write fails', async () => {
    const driver = new WslEngineDriver();
    vi.spyOn(driver, 'getInstalledDistros').mockResolvedValue(['Ubuntu', 'Debian']);
    const configure = vi.spyOn(driver, 'configureWslDistroIntegration').mockResolvedValue(true);
    const manager = new EngineManager(driver);
    const previous = { ...DEFAULT_ENGINE_SETTINGS, wslIntegrationEnabled: true, wslAdditionalDistros: ['ubuntu'] };
    const updated = { ...previous, wslAdditionalDistros: ['DEBIAN'] };
    const persist = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('settings file locked'));

    await expect(manager.applyWslIntegration(previous, updated, persist)).rejects.toThrow('settings file locked');
    expect(configure.mock.calls).toEqual([
      ['Ubuntu', false],
      ['Debian', true],
      ['Debian', false],
      ['Ubuntu', true]
    ]);
    expect(persist).toHaveBeenCalledOnce();

    configure.mockClear();
    persist.mockResolvedValue(undefined);
    await manager.applyWslIntegration(previous, updated, persist);
    expect(configure.mock.calls).toEqual([
      ['Ubuntu', false],
      ['Debian', true]
    ]);
  });

  it('skips persistence when a distro change fails and restores earlier changes', async () => {
    const driver = new WslEngineDriver();
    vi.spyOn(driver, 'getInstalledDistros').mockResolvedValue(['Ubuntu', 'Debian']);
    const configure = vi
      .spyOn(driver, 'configureWslDistroIntegration')
      .mockResolvedValue(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const manager = new EngineManager(driver);
    const previous = { ...DEFAULT_ENGINE_SETTINGS, wslIntegrationEnabled: true, wslAdditionalDistros: ['Ubuntu'] };
    const persist = vi.fn(async () => {});

    await expect(
      manager.applyWslIntegration(previous, { ...previous, wslAdditionalDistros: ['Debian'] }, persist)
    ).rejects.toThrow('Could not enable Docker integration for "Debian"');
    expect(persist).not.toHaveBeenCalled();
    expect(configure.mock.calls).toEqual([
      ['Ubuntu', false],
      ['Debian', true],
      ['Ubuntu', true]
    ]);
  });
});
