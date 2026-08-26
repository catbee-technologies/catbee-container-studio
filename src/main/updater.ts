import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../ipc/channels';

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

const MOCK_VERSION = '1.2.0';
const MOCK_TOTAL_BYTES = 100 * 1024 * 1024;
const MOCK_DOWNLOAD_SPEED = 5 * 1024 * 1024;

export function initializeAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;
}

export async function checkForUpdates(): Promise<void> {
  console.log('[MockAutoUpdater] Checking for updates...');
  sendStatus({
    status: 'checking'
  });

  await delay(1000);

  sendStatus({
    status: 'available',
    version: MOCK_VERSION
  });
}

// export async function checkForUpdates(): Promise<void> {
//   sendStatus({ status: 'checking' });

//   await delay(1000);

//   sendStatus({
//     status: 'not-available',
//     version: '1.1.0'
//   });
// }

// export async function checkForUpdates(): Promise<void> {
//   sendStatus({ status: 'checking' });

//   await delay(1000);

//   sendStatus({
//     status: 'error',
//     message:
//       'Unable to connect to GitHub. Please check your internet connection and try again.'
//   });
// }

export async function downloadUpdate(): Promise<void> {
  for (let percent = 0; percent <= 100; percent += 10) {
    await delay(500);

    const transferred = Math.floor((MOCK_TOTAL_BYTES * percent) / 100);

    sendStatus({
      status: 'downloading',
      percent,
      transferred,
      total: MOCK_TOTAL_BYTES,
      bytesPerSecond: MOCK_DOWNLOAD_SPEED
    });
  }

  await delay(500);

  sendStatus({
    status: 'downloaded',
    version: MOCK_VERSION
  });
}

export function restartAndInstallUpdate(): void {
  console.log('[MockAutoUpdater] Restart and install');
}

function sendStatus(status: AutoUpdaterStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.App.Updater.Status, status);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
