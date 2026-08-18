import { app } from 'electron';

/** Indicates whether the application is running in development mode. */
export const isDev = !app.isPackaged || process.argv.includes('--serve');

/** Indicates whether the application is running on macOS. */
export const isMacOS = process.platform === 'darwin';

export const ZOOM_CONFIG = {
  MIN: -3,
  MAX: 3,
  STEP: 0.5
};
