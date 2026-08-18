import { BrowserWindow } from 'electron';

type WebContentsWithZoomLevelEvent = Electron.WebContents & {
  on(event: 'did-change-zoom-level', listener: () => void): Electron.WebContents;
};

const TITLEBAR_HEIGHT_PX = 48;
const TRAFFIC_LIGHTS_GROUP_HEIGHT_PX = 14;
const TRAFFIC_LIGHTS_BASE_OFFSET_X = 14;

const macTrafficLightsSyncByWindow = new WeakMap<BrowserWindow, () => void>();

export function syncMacTrafficLights(window: BrowserWindow): void {
  macTrafficLightsSyncByWindow.get(window)?.();
}

export function setupMacTrafficLights(window: BrowserWindow): void {
  let zoomCssUpdateTimer: NodeJS.Timeout | null = null;
  let trafficLightsSyncTimer: NodeJS.Timeout | null = null;

  const updateZoomCssVariable = (): void => {
    if (zoomCssUpdateTimer) {
      clearTimeout(zoomCssUpdateTimer);
    }
    zoomCssUpdateTimer = setTimeout(() => {
      zoomCssUpdateTimer = null;
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }
      const zoomFactor = window.webContents.getZoomFactor();
      const script = `document.documentElement.style.setProperty('--app-zoom-factor', '${zoomFactor}');`;
      void window.webContents.executeJavaScript(script).catch(() => {
        // Ignore transient errors while navigating/reloading.
      });
    }, 50);
  };

  const syncTrafficLightsPosition = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    const zoomFactor = window.webContents.getZoomFactor();
    const scaledOffsetX = Math.max(8, Math.round(TRAFFIC_LIGHTS_BASE_OFFSET_X * zoomFactor));
    const scaledTitlebarHeightPx = TITLEBAR_HEIGHT_PX * zoomFactor;
    window.setWindowButtonPosition({
      x: scaledOffsetX,
      y: Math.max(0, Math.round((scaledTitlebarHeightPx - TRAFFIC_LIGHTS_GROUP_HEIGHT_PX) / 2))
    });
  };

  const scheduleTrafficLightsSync = (): void => {
    syncTrafficLightsPosition();
    updateZoomCssVariable();

    if (trafficLightsSyncTimer) {
      clearTimeout(trafficLightsSyncTimer);
    }

    trafficLightsSyncTimer = setTimeout(() => {
      trafficLightsSyncTimer = null;
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }
      syncTrafficLightsPosition();
    }, 100);
  };

  macTrafficLightsSyncByWindow.set(window, scheduleTrafficLightsSync);

  window.setWindowButtonVisibility(true);

  // Keep native traffic lights vertically centered against
  // the zoomed custom titlebar height.
  scheduleTrafficLightsSync();

  window.on('resize', scheduleTrafficLightsSync);
  window.on('enter-full-screen', scheduleTrafficLightsSync);
  window.on('leave-full-screen', scheduleTrafficLightsSync);
  window.on('maximize', scheduleTrafficLightsSync);
  window.on('unmaximize', scheduleTrafficLightsSync);

  window.webContents.on('did-finish-load', scheduleTrafficLightsSync);
  window.webContents.on('zoom-changed', scheduleTrafficLightsSync);

  (window.webContents as WebContentsWithZoomLevelEvent).on('did-change-zoom-level', scheduleTrafficLightsSync);

  window.on('closed', () => {
    if (zoomCssUpdateTimer) {
      clearTimeout(zoomCssUpdateTimer);
      zoomCssUpdateTimer = null;
    }

    if (trafficLightsSyncTimer) {
      clearTimeout(trafficLightsSyncTimer);
      trafficLightsSyncTimer = null;
    }

    macTrafficLightsSyncByWindow.delete(window);
  });
}
