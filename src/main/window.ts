import { BrowserWindow } from 'electron';
import path from 'node:path';
import { isDev, isMacOS } from './app/constants';
import { setupMacTrafficLights } from './app/mac-traffic-lights';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    frame: isMacOS,
    titleBarStyle: isMacOS ? 'hiddenInset' : 'hidden',
    titleBarOverlay: false,
    backgroundColor: '#07121f',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev
    }
  });

  if (isMacOS) {
    setupMacTrafficLights(window);
  }

  if (isDev) {
    void window.loadURL('http://localhost:4281');
    // window.webContents.openDevTools();
  } else {
    void window.loadURL('catbee://app/');
  }

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.once('ready-to-show', () => {
    window.show();
  });

  return window;
}
