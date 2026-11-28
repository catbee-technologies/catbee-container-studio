import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, fail, ok } from '../contracts';
import { logger as appLogger } from '../../main/logger';

const logger = appLogger.child({}, { msgPrefix: '[App] ' });

export function registerWindowHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Shell.ShowItem);
  ipcMain.handle(IPC_CHANNELS.App.Shell.ShowItem, (_event, path: string): IpcResult<{ shown: boolean }> => {
    if (!path || typeof path !== 'string') {
      return fail(new Error('Invalid path.'));
    }
    const resolved = resolve(path);
    if (existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return ok({ shown: true });
    }
    // showItemInFolder silently does nothing for missing paths; highlight the closest existing parent directory instead.
    let parent = dirname(resolved);
    while (!existsSync(parent) && dirname(parent) !== parent) {
      parent = dirname(parent);
    }
    if (!existsSync(parent)) {
      return fail(new Error(`Path not found: ${path}`));
    }
    shell.showItemInFolder(parent);
    return ok({ shown: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.Minimize);
  ipcMain.handle(IPC_CHANNELS.App.Window.Minimize, async (event): Promise<IpcResult<{ minimized: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }
    window.minimize();
    return ok({ minimized: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.GetState);
  ipcMain.handle(
    IPC_CHANNELS.App.Window.GetState,
    async (event): Promise<IpcResult<{ maximized: boolean; fullscreen: boolean }>> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return fail(new Error('Window not found.'));
      }
      return ok({
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen()
      });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.ToggleMaximize);
  ipcMain.handle(IPC_CHANNELS.App.Window.ToggleMaximize, async (event): Promise<IpcResult<{ maximized: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }
    if (window.isMaximized()) {
      window.unmaximize();
      return ok({ maximized: false });
    }
    window.maximize();
    return ok({ maximized: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.Close);
  ipcMain.handle(IPC_CHANNELS.App.Window.Close, async (event): Promise<IpcResult<{ closed: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }
    window.close();
    return ok({ closed: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Quit);
  ipcMain.handle(IPC_CHANNELS.App.Quit, (): IpcResult<{ quit: boolean }> => {
    logger.debug('Quit requested from UI.');
    // Engine and stream shutdown happen in the app-wide before-quit hook so Cmd+Q / tray quit behave the same.
    app.quit();
    return ok({ quit: true });
  });
}
