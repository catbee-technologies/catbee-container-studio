import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { ok } from '../contracts';

export function registerPlatformHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.Get);
  ipcMain.handle(IPC_CHANNELS.App.Platform.Get, () => ok(process.platform));
}
