import { app, BrowserWindow, Menu, shell } from 'electron';
import { isDev, isMacOS, LOG_FILE_PATH, ZOOM_CONFIG } from './constants';
import { syncMacTrafficLights } from './mac-traffic-lights';
import { checkForUpdates } from './updater';

export interface ApplicationMenuOptions {
  getMainWindow: () => BrowserWindow | null;
  showOrCreateMainWindow: () => void;
}

let applicationMenu: Menu | null = null;

function applyZoomDelta(window: BrowserWindow, delta: number): void {
  const currentLevel = window.webContents.getZoomLevel();
  const nextLevel = Math.min(ZOOM_CONFIG.MAX, Math.max(ZOOM_CONFIG.MIN, currentLevel + delta));

  if (nextLevel === currentLevel) {
    return;
  }

  window.webContents.setZoomLevel(nextLevel);
  syncMacTrafficLights(window);
}

function resetZoom(window: BrowserWindow): void {
  window.webContents.setZoomLevel(0);
  syncMacTrafficLights(window);
}

export function buildApplicationMenu({ getMainWindow, showOrCreateMainWindow }: ApplicationMenuOptions): void {
  const getTargetWindow = (): BrowserWindow | null => {
    return BrowserWindow.getFocusedWindow() ?? getMainWindow();
  };

  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
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

        applyZoomDelta(targetWindow, ZOOM_CONFIG.STEP);
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

        applyZoomDelta(targetWindow, -ZOOM_CONFIG.STEP);
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
        isMacOS ? { role: 'close' } : { role: 'quit' }
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
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMacOS ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: async () => {
            const targetWindow = getTargetWindow();
            await checkForUpdates(targetWindow);
          }
        },
        {
          type: 'separator'
        },
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
        },
        ...(!isDev
          ? [
              { type: 'separator' as const },
              {
                label: 'View Log File',
                click: async () => {
                  await shell.openPath(LOG_FILE_PATH);
                }
              }
            ]
          : [])
      ]
    }
  ];

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
}

export function showApplicationMenu(window: BrowserWindow): void {
  if (!applicationMenu) {
    return;
  }
  applicationMenu.popup({ window });
}

export function showApplicationSubmenu(window: BrowserWindow, label: string): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }
  const menuItem = menu.items.find(item => item.label === label);
  if (!menuItem?.submenu) {
    return;
  }
  menuItem.submenu.popup({ window });
}
