import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import {
  checkForUpdates,
  downloadUpdate,
  getReleaseNotes,
  isMicrosoftStoreInstallation,
  restartAndInstallUpdate,
  type PrepareForUpdateInstall
} from '../../main/app/updater';
import { ok } from '../contracts';

export function registerUpdaterHandlers(prepareForUpdateInstall: PrepareForUpdateInstall): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.CheckForUpdates);
  ipcMain.handle(IPC_CHANNELS.App.Updater.CheckForUpdates, async () => {
    await checkForUpdates();
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.DownloadUpdate);
  ipcMain.handle(IPC_CHANNELS.App.Updater.DownloadUpdate, async () => {
    await downloadUpdate();
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Updater.RestartAndInstallUpdate);
  ipcMain.handle(IPC_CHANNELS.App.Updater.RestartAndInstallUpdate, async () => {
    await restartAndInstallUpdate(prepareForUpdateInstall);
  });

  ipcMain.handle(IPC_CHANNELS.App.Updater.IsMicrosoftStore, () => {
    return ok(isMicrosoftStoreInstallation());
  });

  ipcMain.handle(IPC_CHANNELS.App.Updater.GetReleaseNotes, async (_event, version?: string) => {
    return ok(await getReleaseNotes(version));
  });
}
