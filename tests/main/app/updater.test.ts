import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';

vi.mock('electron', () => ({ app: { getVersion: () => '0.6.0' } }));
vi.mock('../../../src/main/app/constants', () => ({ isDev: false, isMacOS: false }));
vi.mock('../../../src/main/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return { autoUpdater: Object.assign(new EventEmitter(), { quitAndInstall: vi.fn(), checkForUpdates: vi.fn() }) };
});

describe('Electron updater', () => {
  let updater: typeof import('../../../src/main/app/updater');
  const send = vi.fn();
  const downloadedUpdate = { version: '0.7.0', files: [], releaseDate: '', downloadedFile: 'update.exe' };

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    autoUpdater.removeAllListeners();
    updater = await import('../../../src/main/app/updater.js');
    updater.initializeAutoUpdater({ isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('waits for background shutdown and ignores duplicate install requests', async () => {
    autoUpdater.emit('update-downloaded', downloadedUpdate);
    const shutdown = Promise.withResolvers<() => void>();
    const prepare = vi.fn(() => shutdown.promise);

    const install = updater.restartAndInstallUpdate(prepare);
    await updater.restartAndInstallUpdate(prepare);
    expect(prepare).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    shutdown.resolve(vi.fn<() => void>());
    await install;
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('blocks installation on shutdown failure and permits retry', async () => {
    autoUpdater.emit('update-downloaded', downloadedUpdate);
    await updater.restartAndInstallUpdate(async () => {
      throw new Error('engine still running');
    });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'error' }));
    await updater.restartAndInstallUpdate(async () => vi.fn<() => void>());
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('offers manual update instructions when the Linux package has no updater', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValue(null);
    await updater.checkForUpdates();
    expect(send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error', message: expect.stringContaining('Download a new archive') })
    );
  });

  it.each(['synchronous', 'asynchronous'])(
    'restores shutdown state after a %s installer failure and permits retry',
    async failure => {
      autoUpdater.emit('update-downloaded', downloadedUpdate);
      const restore = vi.fn<() => void>();
      const prepare = vi.fn(async () => restore);
      const installer = vi.mocked(autoUpdater.quitAndInstall);
      if (failure === 'synchronous') {
        installer.mockImplementationOnce(() => {
          throw new Error('installer failed');
        });
      }

      await updater.restartAndInstallUpdate(prepare);
      if (failure === 'asynchronous') autoUpdater.emit('error', new Error('installer failed'));
      expect(restore).toHaveBeenCalledOnce();
      expect(send).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ status: 'error' }));

      await updater.restartAndInstallUpdate(prepare);
      expect(installer).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps Store installations out of the standalone installer path', async () => {
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: { value: 'win32' },
        windowsStore: { value: true }
      })
    );
    autoUpdater.emit('update-downloaded', downloadedUpdate);
    const prepare = vi.fn(async () => vi.fn<() => void>());

    expect(updater.isMicrosoftStoreInstallation()).toBe(true);
    await updater.restartAndInstallUpdate(prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
