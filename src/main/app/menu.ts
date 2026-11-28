import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { isDev, isMacOS, LOG_DIR_PATH, ZOOM_CONFIG } from './constants';
import { syncMacTrafficLights } from './mac-traffic-lights';
import { logger as appLogger } from '../logger';
import { IPC_CHANNELS } from '../../ipc/channels';

const logger = appLogger.child({}, { msgPrefix: '[Menu] ' });

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
    ...(isDev
      ? [
          {
            role: 'toggleDevTools' as const,
            label: 'Developer Tools'
          },
          { type: 'separator' as const }
        ]
      : []),
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

type EngineMenuAction = 'start' | 'stop' | 'restart';

function runEngineAction(action: EngineMenuAction): void {
  void (async () => {
    const { dockerManager } = await import('../docker/services/docker.manager.js');
    switch (action) {
      case 'start':
        return await dockerManager.startEmbeddedEngine();
      case 'stop':
        return await dockerManager.stopEmbeddedEngine();
      case 'restart':
        return await dockerManager.restartEmbeddedEngine();
    }
  })().catch((error: unknown) => {
    logger.error({ err: error }, `Built-in engine ${action} failed.`);
    dialog.showErrorBox(
      `Could not ${action} the built-in engine`,
      error instanceof Error ? error.message : String(error)
    );
  });
}

function createEngineSubmenu(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Start Built-in Engine', click: () => runEngineAction('start') },
    { label: 'Stop Built-in Engine', click: () => runEngineAction('stop') },
    { label: 'Restart Built-in Engine', click: () => runEngineAction('restart') }
  ];
}

function navigateToSettingsAbout(options: ApplicationMenuOptions): void {
  options.showOrCreateMainWindow();
  const window = options.getMainWindow();
  if (!window || window.isDestroyed()) {
    return;
  }
  const sendNavigate = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.App.Navigate, {
        path: '/settings',
        queryParams: { tab: 'about' }
      });
    }
  };
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', sendNavigate);
  } else {
    sendNavigate();
  }
}

function createAppSubmenu(options: ApplicationMenuOptions): Electron.MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      {
        label: `About ${app.name}`,
        click: () => {
          navigateToSettingsAbout(options);
        }
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  };
}

function createHelpSubmenu(options: ApplicationMenuOptions): Electron.MenuItemConstructorOptions[] {
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
        navigateToSettingsAbout(options);
      }
    }
  ];
}

export function buildApplicationMenu(options: ApplicationMenuOptions): void {
  const { getMainWindow, showOrCreateMainWindow } = options;
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS has a native application menu.
    ...(isMacOS ? [createAppSubmenu(options)] : []),
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
      label: 'Engine',
      submenu: createEngineSubmenu()
    },
    {
      label: 'Window',
      submenu: createWindowSubmenu()
    },
    {
      role: 'help',
      submenu: createHelpSubmenu(options)
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
