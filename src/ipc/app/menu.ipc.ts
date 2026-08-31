import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, fail, ok } from '../contracts';
import { showApplicationMenu, showApplicationSubmenu } from '../../main/menu';

export function registerMenuHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Menu.Show);
  ipcMain.handle(IPC_CHANNELS.App.Menu.Show, (event): IpcResult<{ shown: boolean }> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }
    showApplicationMenu(window);
    return ok({ shown: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Menu.ShowSubmenu);
  ipcMain.handle(IPC_CHANNELS.App.Menu.ShowSubmenu, (event, label: string): IpcResult<{ shown: boolean }> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }
    showApplicationSubmenu(window, label);
    return ok({ shown: true });
  });
}
