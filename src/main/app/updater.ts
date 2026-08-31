import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';
import { isDev } from './constants';
import { logger } from '../logger';
import { IPC_CHANNELS } from '../../ipc/channels';

export type AutoUpdaterStatus =
  | {
      status: 'checking';
    }
  | {
      status: 'available';
      version: string;
    }
  | {
      status: 'not-available';
      version: string;
    }
  | {
      status: 'downloading';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | {
      status: 'downloaded';
      version: string;
    }
  | {
      status: 'error';
      message: string;
    };

let mainWindow: BrowserWindow | null = null;

export function initializeAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('[AutoUpdater] Checking for update...');
    sendStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', info => {
    logger.info(`[AutoUpdater] Update available: ${info.version}`);
    sendStatus({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', info => {
    logger.info(`[AutoUpdater] No update available: ${info.version}`);
    sendStatus({ status: 'not-available', version: info.version });
  });

  autoUpdater.on('download-progress', progress => {
    logger.info(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);

    sendStatus({
      status: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', info => {
    logger.info(`[AutoUpdater] Update downloaded: ${info.version}`);
    sendStatus({ status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', error => {
    logger.error({ err: error }, '[AutoUpdater] Error');
    sendStatus({ status: 'error', message: getErrorMessage(error) });
  });
}

export async function checkForUpdates(): Promise<void> {
  if (isDev) {
    logger.info('[AutoUpdater] Skipping update check in development.');
    return;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    logger.error({ err: error }, '[AutoUpdater] Failed to check for updates');
    sendStatus({
      status: 'error',
      message: getErrorMessage(error)
    });
  }
}

export async function downloadUpdate(): Promise<void> {
  if (isDev) {
    return;
  }

  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    logger.error({ err: error }, '[AutoUpdater] Failed to download update');
    sendStatus({ status: 'error', message: getErrorMessage(error) });
  }
}

export function restartAndInstallUpdate(): void {
  if (isDev) {
    return;
  }
  logger.info('[AutoUpdater] Restarting and installing update...');
  autoUpdater.quitAndInstall();
}

function sendStatus(status: AutoUpdaterStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.App.Updater.Status, status);
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'An unexpected error occurred while checking for updates.';
  }

  if (
    error.message.includes('ERR_UPDATER_INVALID_RELEASE_FEED') ||
    error.message.includes('Unable to find latest version on GitHub')
  ) {
    return 'No compatible release is currently available.';
  }

  if (
    error.message.includes('ENOTFOUND') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ETIMEDOUT')
  ) {
    return 'Unable to connect to GitHub. Please check your internet connection and try again.';
  }

  return 'An unexpected error occurred while checking for updates.';
}
