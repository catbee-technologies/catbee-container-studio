import { Menu, app, BrowserWindow, protocol } from 'electron';
import { registerIpcHandlers } from '../ipc';
import { registerAppProtocol } from './protocol';
import { createMainWindow, syncMacTrafficLights } from './window';

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

  function applyZoomDelta(window: BrowserWindow, delta: number): void {
    const currentLevel = window.webContents.getZoomLevel();
    window.webContents.setZoomLevel(currentLevel + delta);
    syncMacTrafficLights(window);
  }

  function resetZoom(window: BrowserWindow): void {
    window.webContents.setZoomLevel(0);
    syncMacTrafficLights(window);
  }

  function getTargetWindow(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow() ?? mainWindow;
  }

  function showOrCreateMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      openMainWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    mainWindow.focus();
  }

  function buildApplicationMenu(): void {
    const isMac = process.platform === 'darwin';
    const isDev = !app.isPackaged || process.argv.includes('--serve');

    const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
      { role: 'reload' },
      { role: 'forceReload' },
      ...(isDev ? ([{ role: 'toggleDevTools' as const }] as Electron.MenuItemConstructorOptions[]) : []),
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        click: () => {
          const targetWindow = getTargetWindow();
          if (!targetWindow) {
            return;
          }
          resetZoom(targetWindow);
        }
      },
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+=',
        click: () => {
          const targetWindow = getTargetWindow();
          if (!targetWindow) {
            return;
          }
          applyZoomDelta(targetWindow, 0.5);
        }
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: () => {
          const targetWindow = getTargetWindow();
          if (!targetWindow) {
            return;
          }
          applyZoomDelta(targetWindow, -0.5);
        }
      },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ];

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        role: 'appMenu'
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Show CatBee Window',
            accelerator: 'CmdOrCtrl+Shift+1',
            click: () => {
              showOrCreateMainWindow();
            }
          },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' }
        ]
      },
      {
        role: 'editMenu'
      },
      {
        label: 'View',
        submenu: viewSubmenu
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' as const },
          { role: 'zoom' as const },
          ...(isMac
            ? ([{ type: 'separator' }, { role: 'front' as const }] as Electron.MenuItemConstructorOptions[])
            : [{ role: 'close' as const }])
        ]
      },
      {
        role: 'help',
        submenu: [
          {
            label: 'About CatBee Container Studio',
            click: () => {
              app.showAboutPanel();
            }
          },
          {
            label: 'Show Main Window',
            click: () => {
              showOrCreateMainWindow();
            }
          }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  app.whenReady().then(() => {
    buildApplicationMenu();
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
