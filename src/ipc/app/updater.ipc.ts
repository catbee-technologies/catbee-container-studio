import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import {
  checkForUpdates,
  downloadUpdate,
  isMicrosoftStoreInstallation,
  restartAndInstallUpdate
} from '../../main/app/updater';
import { ok } from '../contracts';

export function registerUpdaterHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.CheckForUpdates);
  ipcMain.handle(IPC_CHANNELS.App.Updater.CheckForUpdates, async () => {
    await checkForUpdates();
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.DownloadUpdate);
  ipcMain.handle(IPC_CHANNELS.App.Updater.DownloadUpdate, async () => {
    await downloadUpdate();
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.RestartAndInstallUpdate);
  ipcMain.handle(IPC_CHANNELS.App.Updater.RestartAndInstallUpdate, () => {
    restartAndInstallUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.App.Updater.IsMicrosoftStore, () => {
    return ok(isMicrosoftStoreInstallation());
  });
}
