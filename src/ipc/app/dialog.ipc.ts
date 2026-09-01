import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, ok } from '../contracts';

export function registerDialogHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Dialog.SelectDirectory);
  ipcMain.handle(
    IPC_CHANNELS.App.Dialog.SelectDirectory,
    async (event): Promise<IpcResult<{ path: string | null }>> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window
        ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });

      if (result.canceled || result.filePaths.length === 0) {
        return ok({ path: null });
      }

      return ok({ path: result.filePaths[0] });
    }
  );
}
