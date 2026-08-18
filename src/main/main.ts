import { app, BrowserWindow, protocol } from 'electron';
import { dockerService, registerIpcHandlers } from '../ipc';
import { registerAppProtocol } from './protocol';
import { createMainWindow } from './window';
import { buildApplicationMenu } from './menu';
import { logger } from './logger';
import { isDev, isMacOS } from './constants';

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  logger.info('Another instance is already running; quitting');
  app.quit();
} else {
  logger.info(`Application starting in ${isDev ? 'development' : 'production'} mode`);
  let mainWindow: BrowserWindow | null = null;

  function openMainWindow(): void {
    logger.debug('Creating main window');
    mainWindow = createMainWindow();
    mainWindow.maximize();
    mainWindow.on('closed', () => {
      logger.debug('Main window closed');
      mainWindow = null;
    });
  }

  function showOrCreateMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.debug('Main window does not exist; creating it');
      openMainWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      logger.debug('Restoring minimized main window');
      mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
      logger.debug('Showing hidden main window');
      mainWindow.show();
    }

    mainWindow.focus();
  }

  app.on('second-instance', () => {
    logger.info('Second application instance detected');
    showOrCreateMainWindow();
    mainWindow?.moveTop();
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

  app
    .whenReady()
    .then(async () => {
      logger.info('Application is ready');
      try {
        await dockerService.initialize();
        logger.info('[DockerConnection] Docker connected successfully.');
      } catch (error) {
        logger.error({ err: error }, '[DockerConnection] Failed to connect to Docker.');
      }

      buildApplicationMenu({ getMainWindow: () => mainWindow, showOrCreateMainWindow });
      registerAppProtocol();
      registerIpcHandlers();
      openMainWindow();

      app.on('activate', () => {
        logger.debug('Application activated');
        if (BrowserWindow.getAllWindows().length === 0) {
          openMainWindow();
        }
      });

      app.on('window-all-closed', () => {
        logger.debug('All application windows closed');
        if (!isMacOS) {
          logger.info('Quitting application');
          app.quit();
        }
      });
    })
    .catch((error: unknown) => {
      logger.fatal({ err: error }, 'Failed to initialize application');
      app.quit();
    });
}
