import { BrowserWindow, Menu, shell } from 'electron';
import { isDev, isMacOS, LOG_DIR_PATH, ZOOM_CONFIG } from './constants';
import { syncMacTrafficLights } from './mac-traffic-lights';
import { showAboutDialog } from './about';

export interface ApplicationMenuOptions {
  getMainWindow: () => BrowserWindow | null;
  showOrCreateMainWindow: () => void;
}

let applicationMenu: Menu | null = null;

function getTargetWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? getMainWindow();
}

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

function createViewSubmenu(getMainWindow: () => BrowserWindow | null): Electron.MenuItemConstructorOptions[] {
  const getWindow = () => getTargetWindow(getMainWindow);

  return [
    {
      role: 'reload',
      label: 'Reload'
    },
    {
      role: 'forceReload',
      label: 'Force Reload'
    },
    ...(isDev
      ? [
          {
            role: 'toggleDevTools' as const,
            label: 'Developer Tools'
          }
        ]
      : []),
    { type: 'separator' },

    {
      label: 'Actual Size',
      accelerator: 'CmdOrCtrl+0',
      click: () => {
        const window = getWindow();

        if (window) {
          resetZoom(window);
        }
      }
    },
    {
      label: 'Zoom In',
      accelerator: 'CmdOrCtrl+=',
      click: () => {
        const window = getWindow();

        if (window) {
          applyZoomDelta(window, ZOOM_CONFIG.STEP);
        }
      }
    },
    {
      label: 'Zoom Out',
      accelerator: 'CmdOrCtrl+-',
      click: () => {
        const window = getWindow();

        if (window) {
          applyZoomDelta(window, -ZOOM_CONFIG.STEP);
        }
      }
    },
    { type: 'separator' },
    {
      role: 'togglefullscreen',
      label: 'Toggle Full Screen'
    }
  ];
}

function createFileSubmenu(showOrCreateMainWindow: () => void): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Show CatBee Window',
      accelerator: 'CmdOrCtrl+Shift+1',
      click: showOrCreateMainWindow
    },
    { type: 'separator' },
    isMacOS
      ? {
          role: 'close',
          label: 'Close Window'
        }
      : {
          role: 'quit',
          label: 'Exit CatBee Container Studio',
          accelerator: 'Alt+F4'
        }
  ];
}

function createWindowSubmenu(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      role: 'minimize',
      label: 'Minimize'
    },
    {
      role: 'zoom',
      label: isMacOS ? 'Zoom' : 'Maximize'
    },
    {
      type: 'separator'
    },
    {
      role: 'close',
      label: 'Close'
    },
    ...(isMacOS
      ? [
          {
            type: 'separator' as const
          },
          {
            role: 'front' as const,
            label: 'Bring All to Front'
          }
        ]
      : [])
  ];
}

function createHelpSubmenu(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'View Logs',
      click: async () => {
        await shell.openPath(LOG_DIR_PATH);
      }
    },
    { type: 'separator' },
    {
      label: 'About CatBee Container Studio',
      click: () => {
        showAboutDialog();
      }
    }
  ];
}

export function buildApplicationMenu({ getMainWindow, showOrCreateMainWindow }: ApplicationMenuOptions): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS has a native application menu.
    ...(isMacOS
      ? [
          {
            role: 'appMenu' as const
          }
        ]
      : []),
    {
      label: 'File',
      submenu: createFileSubmenu(showOrCreateMainWindow)
    },
    {
      role: 'editMenu'
    },
    {
      label: 'View',
      submenu: createViewSubmenu(getMainWindow)
    },
    {
      label: 'Window',
      submenu: createWindowSubmenu()
    },
    {
      role: 'help',
      submenu: createHelpSubmenu()
    }
  ];

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
}

export function showApplicationMenu(window: BrowserWindow): void {
  applicationMenu?.popup({ window });
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
