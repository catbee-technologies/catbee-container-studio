import { app } from 'electron';

/**
 * The version of the application.
 * Do not modify this value manually, as it may be overwritten during the build process.
 */
export const APP_VERSION = '0.1.0-rc.3';

/** Indicates whether the application is running in development mode. */
export const isDev = !app.isPackaged || process.argv.includes('--serve');

/** Indicates whether the application is running on macOS. */
export const isMacOS = process.platform === 'darwin';

export const ZOOM_CONFIG = {
  MIN: -3,
  MAX: 3,
  STEP: 0.5
};

/** The path to the log file for the application. */
export const LOG_FILE_PATH = `${app.getPath('logs')}/catbee-container-studio.log`;
