import { app, BrowserWindow, protocol } from 'electron';
import { registerIpcHandlers } from '../ipc';
import { registerAppProtocol } from './protocol';
import { createMainWindow } from './window';

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.moveTop();
  });

  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'catbee',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ]);

  function openMainWindow(): void {
    mainWindow = createMainWindow();
    mainWindow.maximize();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.whenReady().then(() => {
    registerAppProtocol();
    registerIpcHandlers();
    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openMainWindow();
      }
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  });
}
