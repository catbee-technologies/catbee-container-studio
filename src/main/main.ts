import { app, BrowserWindow, protocol } from 'electron';
import { registerIpcHandlers } from '../ipc';
import { registerAppProtocol } from './app/protocol';
import { createMainWindow } from './window';
import { buildApplicationMenu } from './app/menu';
import { logger as appLogger } from './logger';
import { isDev, isMacOS } from './app/constants';
import { requestQuitConfirmation } from './app/quit-confirmation';
import { initializeAutoUpdater, skipAutoInstallOnQuit } from './app/updater';
import { IPC_CHANNELS } from '../ipc/channels';
import { dockerManager } from './docker/services/docker.manager';
import { engineManager } from './docker/embedded/engine.manager';
import type { DockerInitializationStatus } from './docker/types/runtime.types';
import { stopAllStreamSessions } from '../ipc/docker/streams.ipc';

app.commandLine.appendSwitch('force-color-profile', 'srgb');

const logger = appLogger.child({}, { msgPrefix: '[App] ' });

const SHUTDOWN_TIMEOUT_MS = 30_000;
const isHeadlessTeardown = process.argv.includes('--uninstall') || process.argv.includes('--factory-reset');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  if (isHeadlessTeardown) {
    logger.error('Close the running CatBee application before requesting headless teardown.');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  logger.info(`Application starting in ${isDev ? 'development' : 'production'} mode`);
  let mainWindow: BrowserWindow | null = null;

  function openMainWindow(): void {
    logger.debug('Creating main window');
    mainWindow = createMainWindow();
    mainWindow.maximize();

    mainWindow.on('close', event => {
      if (quitConfirmed || shutdownState !== 'idle') {
        return;
      }
      if (!isMacOS) {
        event.preventDefault();
        app.quit();
      }
    });

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

  let quitConfirmed = false;
  let isConfirmingQuit = false;
  let shutdownState: 'idle' | 'running' | 'done' = 'idle';
  let backgroundShutdown: Promise<void> | null = null;

  function stopBackgroundServices(): Promise<void> {
    if (backgroundShutdown) return backgroundShutdown;

    logger.info('Shutting down background services');
    try {
      stopAllStreamSessions();
    } catch (err) {
      logger.warn({ err }, 'Error stopping stream sessions on quit');
    }
    backgroundShutdown = dockerManager.shutdown().finally(() => {
      backgroundShutdown = null;
    });
    return backgroundShutdown;
  }

  async function waitForBackgroundShutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Background shutdown timed out.')), SHUTDOWN_TIMEOUT_MS);
    });
    try {
      await Promise.race([stopBackgroundServices(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function prepareForUpdateInstall(): Promise<() => void> {
    if (shutdownState !== 'idle' || isConfirmingQuit) {
      throw new Error('CatBee is already closing.');
    }
    shutdownState = 'running';
    try {
      await waitForBackgroundShutdown();
      shutdownState = 'done';
    } catch (err) {
      shutdownState = 'idle';
      throw err;
    }
    return () => {
      shutdownState = 'idle';
    };
  }

  // Stop the built-in engine before exiting on every quit path (menu, Cmd+Q, window close, IPC).
  app.on('before-quit', event => {
    if (shutdownState === 'done') {
      return;
    }
    event.preventDefault();
    if (shutdownState === 'running') {
      return;
    }

    if (!quitConfirmed) {
      if (isConfirmingQuit) {
        return;
      }
      isConfirmingQuit = true;
      void (async () => {
        try {
          const confirmed = await requestQuitConfirmation(mainWindow);
          if (confirmed) {
            quitConfirmed = true;
            logger.debug('Quit confirmed by user.');
            app.quit();
          } else {
            logger.debug('Quit cancelled by user.');
          }
        } catch (err) {
          logger.error({ err }, 'Could not request quit confirmation.');
        } finally {
          isConfirmingQuit = false;
        }
      })();
      return;
    }

    shutdownState = 'running';

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.App.Quitting);
    }

    void waitForBackgroundShutdown()
      .catch(err => {
        logger.error({ err }, 'Background shutdown did not finish before quit');
        skipAutoInstallOnQuit();
      })
      .finally(() => {
        shutdownState = 'done';
        app.quit();
      });
  });

  app.on('second-instance', () => {
    logger.debug('Second application instance detected');
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
      logger.debug('Application is ready');

      if (isHeadlessTeardown) {
        logger.info('Detected --uninstall or --factory-reset command line flag; executing headless teardown...');
        await dockerManager.factoryResetTeardown((progress, stage) => {
          logger.debug(`[Teardown] ${progress}% - ${stage}`);
        });
        logger.info('Headless teardown finished cleanly; exiting.');
        quitConfirmed = true;
        shutdownState = 'done';
        app.quit();
        return;
      }

      buildApplicationMenu({ getMainWindow: () => mainWindow, showOrCreateMainWindow });
      registerAppProtocol();
      registerIpcHandlers(prepareForUpdateInstall);
      openMainWindow();

      if (mainWindow) {
        initializeAutoUpdater(mainWindow);
      }

      engineManager.onOperationProgress(progress => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.App.Engine.Progress, progress);
        }
      });

      void (async () => {
        try {
          const { k8sManager } = await import('./k8s/k8s-manager.js');
          k8sManager.onProgress(progress => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.App.K8s.Progress, progress);
            }
          });
          if (mainWindow) {
            mainWindow.webContents.on('did-finish-load', () => {
              const current = k8sManager.getCurrentProgress();
              if (current && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(IPC_CHANNELS.App.K8s.Progress, current);
              }
            });
          }
        } catch (err) {
          logger.debug('Could not register k8sManager progress listener:', err);
        }
      })();

      let engineInitializationState: DockerInitializationStatus['state'] | undefined;
      void dockerManager
        .initialize(
          status => {
            engineInitializationState = status.state;
            if (!mainWindow || mainWindow.isDestroyed()) {
              return;
            }
            mainWindow.webContents.send(IPC_CHANNELS.App.Initialization.Docker.Status, status);
          },
          () => {
            if (!mainWindow || mainWindow.isDestroyed()) {
              return;
            }
            mainWindow.show();
            mainWindow.focus();
          }
        )
        .catch(error => {
          if (engineInitializationState !== 'engine-not-installed' && engineInitializationState !== 'error') {
            logger.error({ err: error }, 'Failed to initialize Docker service.');
          }
        });

      app.on('activate', () => {
        logger.debug('Application activated');
        if (BrowserWindow.getAllWindows().length === 0) {
          openMainWindow();
        }
      });

      app.on('window-all-closed', () => {
        logger.debug('All application windows closed');
        if (!isMacOS) {
          logger.debug('Quitting application');
          app.quit();
        }
      });
    })
    .catch((error: unknown) => {
      logger.fatal({ err: error }, 'Failed to initialize application');
      if (isHeadlessTeardown) app.exit(1);
      else app.quit();
    });
}
