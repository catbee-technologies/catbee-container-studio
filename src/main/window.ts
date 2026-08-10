import { BrowserWindow } from 'electron';
import path from 'node:path';

export function createMainWindow(): BrowserWindow {
  const dev = process.argv.includes('--serve');
  const isMacOS = process.platform === 'darwin';
  const titlebarHeightPx = 44;
  const trafficLightsGroupHeightPx = 14;
  const size = {
    width: 1400,
    height: 900
  };
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
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
      devTools: dev
    }
  });

  if (isMacOS) {
    window.setWindowButtonVisibility(true);
    // Align native traffic lights to the vertical center of the custom titlebar.
    window.setWindowButtonPosition({
      x: 14,
      y: Math.round((titlebarHeightPx - trafficLightsGroupHeightPx) / 2)
    });
  }

  if (dev) {
    window.loadURL('http://localhost:4281');
    // window.webContents.openDevTools();
  } else {
    window.loadURL('catbee://app/');
  }

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.once('ready-to-show', () => {
    window.show();
  });

  return window;
}
