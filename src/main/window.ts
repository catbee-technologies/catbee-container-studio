import { BrowserWindow } from 'electron';
import path from 'node:path';

const macTrafficLightsSyncByWindow = new WeakMap<BrowserWindow, () => void>();

export function syncMacTrafficLights(window: BrowserWindow): void {
  macTrafficLightsSyncByWindow.get(window)?.();
}

export function createMainWindow(): BrowserWindow {
  const dev = process.argv.includes('--serve');
  const isMacOS = process.platform === 'darwin';
  const titlebarHeightPx = 48;
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
    const trafficLightsBaseOffsetX = 14;
    const updateZoomCssVariable = (): void => {
      const zoomFactor = window.webContents.getZoomFactor();
      const script = `document.documentElement.style.setProperty('--app-zoom-factor', '${zoomFactor}');`;
      void window.webContents.executeJavaScript(script).catch(() => {
        // Ignore transient errors while navigating/reloading.
      });
    };

    const syncTrafficLightsPosition = (): void => {
      const zoomFactor = window.webContents.getZoomFactor();
      const scaledOffsetX = Math.max(8, Math.round(trafficLightsBaseOffsetX * zoomFactor));
      const scaledTitlebarHeightPx = titlebarHeightPx * zoomFactor;

      window.setWindowButtonPosition({
        x: scaledOffsetX,
        y: Math.max(0, Math.round((scaledTitlebarHeightPx - trafficLightsGroupHeightPx) / 2))
      });
    };

    const scheduleTrafficLightsSync = (): void => {
      syncTrafficLightsPosition();
      updateZoomCssVariable();
      setTimeout(syncTrafficLightsPosition, 0);
      setTimeout(syncTrafficLightsPosition, 100);
      setTimeout(syncTrafficLightsPosition, 220);
      setTimeout(updateZoomCssVariable, 0);
      setTimeout(updateZoomCssVariable, 100);
      setTimeout(updateZoomCssVariable, 220);
    };

    macTrafficLightsSyncByWindow.set(window, scheduleTrafficLightsSync);

    window.setWindowButtonVisibility(true);
    // Keep native traffic lights vertically centered against zoomed custom titlebar height.
    scheduleTrafficLightsSync();

    window.on('resize', () => {
      scheduleTrafficLightsSync();
    });

    window.on('enter-full-screen', () => {
      scheduleTrafficLightsSync();
    });

    window.on('leave-full-screen', () => {
      scheduleTrafficLightsSync();
    });

    window.on('maximize', () => {
      scheduleTrafficLightsSync();
    });

    window.on('unmaximize', () => {
      scheduleTrafficLightsSync();
    });

    window.webContents.on('did-finish-load', () => {
      scheduleTrafficLightsSync();
    });

    window.webContents.on('zoom-changed', () => {
      scheduleTrafficLightsSync();
    });

    // Menu-driven zoom actions (View > Actual Size/Zoom In/Zoom Out).
    type WebContentsWithZoomLevelEvent = Electron.WebContents & {
      on(event: 'did-change-zoom-level', listener: () => void): Electron.WebContents;
    };
    (window.webContents as WebContentsWithZoomLevelEvent).on('did-change-zoom-level', () => {
      scheduleTrafficLightsSync();
    });

    // Allow zoom shortcuts, but re-center traffic lights immediately after key handling.
    window.webContents.on('before-input-event', (_event, input) => {
      const isCmdOrCtrl = input.meta || input.control;
      const key = (input.key ?? '').toLowerCase();
      const isZoomShortcut =
        isCmdOrCtrl &&
        (key === '+' ||
          key === '=' ||
          key === '-' ||
          key === '_' ||
          key === '0' ||
          input.code === 'NumpadAdd' ||
          input.code === 'NumpadSubtract');

      if (isZoomShortcut) {
        scheduleTrafficLightsSync();
      }
    });

    window.on('closed', () => {
      macTrafficLightsSyncByWindow.delete(window);
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
