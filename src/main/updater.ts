import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { isDev } from './constants';
import { logger } from './logger';

export function initializeAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('[AutoUpdater] Checking for update...');
  });

  autoUpdater.on('update-available', info => {
    logger.info(`[AutoUpdater] Update available: ${info.version}`);
  });

  autoUpdater.on('update-not-available', info => {
    logger.info(`[AutoUpdater] No update available: ${info.version}`);
  });

  autoUpdater.on('download-progress', progress => {
    logger.info(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
  });

  autoUpdater.on('update-downloaded', info => {
    logger.info(`[AutoUpdater] Update downloaded: ${info.version}`);
  });

  autoUpdater.on('error', error => {
    logger.error({ err: error }, '[AutoUpdater] Error');
  });
}

export async function checkForUpdates(window: BrowserWindow | null): Promise<void> {
  if (isDev) {
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();

    if (!result) {
      return;
    }

    if (!result.isUpdateAvailable) {
      await showMessageBox(window, {
        type: 'info',
        title: 'No Updates Available',
        message: 'CatBee Container Studio is up to date.',
        detail: `Current version: ${autoUpdater.currentVersion.version}`,
        buttons: ['OK']
      });

      return;
    }

    const downloadResponse = await showMessageBox(window, {
      type: 'info',
      title: 'Update Available',
      message: `CatBee Container Studio ${result.updateInfo.version} is available.`,
      detail: 'Would you like to download the update?',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (downloadResponse.response !== 0) {
      return;
    }

    await autoUpdater.downloadUpdate();

    const installResponse = await showMessageBox(window, {
      type: 'info',
      title: 'Update Ready',
      message: 'The update has been downloaded.',
      detail: 'Restart CatBee Container Studio to install the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (installResponse.response === 0) {
      autoUpdater.quitAndInstall();
    }
  } catch (error) {
    logger.error({ err: error }, '[AutoUpdater] Failed to check for updates');

    await showMessageBox(window, {
      type: 'error',
      title: 'Update Check Failed',
      message: 'Unable to check for updates.',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['OK']
    });
  }
}

async function showMessageBox(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  if (window) {
    return dialog.showMessageBox(window, options);
  }

  return dialog.showMessageBox(options);
}
