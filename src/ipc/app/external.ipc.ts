import { ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, fail, ok } from '../contracts';

export function registerExternalHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.External.Open);
  ipcMain.handle(
    IPC_CHANNELS.App.External.Open,
    async (_event, url: string): Promise<IpcResult<{ opened: boolean }>> => {
      if (!url || typeof url !== 'string') {
        return fail(new Error('Invalid URL.'));
      }
      try {
        const parsedUrl = new URL(url);
        const allowedProtocols = ['http:', 'https:', 'ms-windows-store:'];
        if (!allowedProtocols.includes(parsedUrl.protocol)) {
          return fail(new Error('Unsupported URL protocol.'));
        }
        await shell.openExternal(parsedUrl.href);
        return ok({ opened: true });
      } catch {
        return fail(new Error('Invalid URL.'));
      }
    }
  );
}
