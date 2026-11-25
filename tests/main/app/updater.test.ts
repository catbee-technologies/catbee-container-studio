import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater, type BaseUpdater } from 'electron-updater';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), {
      getVersion: () => '0.6.0',
      quit: vi.fn(),
      releaseSingleInstanceLock: vi.fn()
    })
  };
});
vi.mock('../../../src/main/app/constants', () => ({ isDev: false, isMacOS: false }));
vi.mock('../../../src/main/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      quitAndInstall: vi.fn(),
      installAsync: vi.fn(),
      checkForUpdates: vi.fn()
    })
  };
});

describe('Electron updater', () => {
  let updater: typeof import('../../../src/main/app/updater');
  const send = vi.fn();
  const downloadedUpdate = { version: '0.7.0', files: [], releaseDate: '', downloadedFile: 'update.exe' };

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    app.removeAllListeners('quit');
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
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'downloaded',
      version: downloadedUpdate.version,
      install: { phase: 'preparing' }
    });
    await updater.restartAndInstallUpdate(prepare);
    expect(prepare).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await updater.checkForUpdates();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'downloaded',
      version: downloadedUpdate.version,
      install: { phase: 'preparing' }
    });
    shutdown.resolve(vi.fn<() => void>());
    await install;
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'downloaded',
      version: downloadedUpdate.version,
      install: { phase: 'installing' }
    });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('blocks installation on shutdown failure and permits retry', async () => {
    autoUpdater.emit('update-downloaded', downloadedUpdate);
    await updater.restartAndInstallUpdate(async () => {
      throw new Error('engine still running');
    });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'downloaded',
      version: downloadedUpdate.version,
      install: { phase: 'failed', message: 'CatBee could not finish shutting down.' }
    });
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

  it.each(['deb', 'rpm'])('reopens CatBee after a successful Linux %s update', async extension => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    autoUpdater.emit('update-downloaded', { ...downloadedUpdate, downloadedFile: `update.${extension}` });
    const install = Promise.withResolvers<boolean>();
    vi.mocked((autoUpdater as BaseUpdater).installAsync).mockReturnValue(install.promise);
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const update = updater.restartAndInstallUpdate(async () => vi.fn<() => void>());
    await Promise.resolve();
    expect((autoUpdater as BaseUpdater).installAsync).toHaveBeenCalledWith(false, false);
    expect(app.quit).not.toHaveBeenCalled();
    install.resolve(true);
    await update;

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    app.emit('quit', {} as Electron.Event, 0);
    expect(app.releaseSingleInstanceLock).toHaveBeenCalledBefore(vi.mocked(spawn));
    expect(spawn).toHaveBeenCalledWith(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('restores shutdown state and permits retry after a Linux package update fails', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    autoUpdater.emit('update-downloaded', { ...downloadedUpdate, downloadedFile: 'update.deb' });
    vi.mocked((autoUpdater as BaseUpdater).installAsync)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const restore = vi.fn<() => void>();
    const prepare = vi.fn(async () => restore);

    await updater.restartAndInstallUpdate(prepare);
    expect(restore).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.listenerCount('quit')).toBe(0);
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'downloaded',
      version: downloadedUpdate.version,
      install: { phase: 'failed', message: 'Could not install the update.' }
    });

    await updater.restartAndInstallUpdate(prepare);
    expect(app.quit).toHaveBeenCalledOnce();
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
      expect(send).toHaveBeenLastCalledWith(expect.any(String), {
        status: 'downloaded',
        version: downloadedUpdate.version,
        install: {
          phase: 'failed',
          message: failure === 'synchronous' ? 'Could not start the update installer.' : 'Could not install the update.'
        }
      });

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
