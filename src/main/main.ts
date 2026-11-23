import { app, BrowserWindow, dialog, protocol } from 'electron';
import { registerIpcHandlers } from '../ipc';
import { registerAppProtocol } from './app/protocol';
import { createMainWindow } from './window';
import { buildApplicationMenu } from './app/menu';
import { logger } from './logger';
import { isDev, isMacOS } from './app/constants';
import { initializeAutoUpdater, skipAutoInstallOnQuit } from './app/updater';
import { IPC_CHANNELS } from '../ipc/channels';
import { dockerManager } from './docker/services/docker.manager';
import { engineManager } from './docker/embedded/engine.manager';
import { stopAllStreamSessions } from '../ipc/docker/streams.ipc';

app.commandLine.appendSwitch('force-color-profile', 'srgb');

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

    logger.info('Shutting down background services before quit');
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

  async function requestQuitConfirmation(parentWindow?: BrowserWindow | null): Promise<boolean> {
    const target = parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow;
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) {
        target.restore();
      }
      target.show();
      target.focus();
    }

    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Quit CatBee Container Studio',
      message: 'Are you sure you want to quit CatBee Container Studio?',
      detail: 'Any running containers and background services may be stopped.'
    };

    const { response } =
      target && !target.isDestroyed()
        ? await dialog.showMessageBox(target, options)
        : await dialog.showMessageBox(options);

    return response === 0;
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
            logger.info('[App] Quit confirmed by user.');
            app.quit();
          } else {
            logger.info('[App] Quit cancelled by user.');
          }
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
        logger.warn({ err }, 'Error stopping built-in engine on quit');
        skipAutoInstallOnQuit();
      })
      .finally(() => {
        shutdownState = 'done';
        app.quit();
      });
  });

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

      if (isHeadlessTeardown) {
        logger.info('Detected --uninstall or --factory-reset command line flag; executing headless teardown...');
        await dockerManager.factoryResetTeardown((progress, stage) => {
          logger.info(`[Teardown] ${progress}% - ${stage}`);
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
          logger.debug('[Main] Could not register k8sManager progress listener:', err);
        }
      })();

      void dockerManager
        .initialize(
          status => {
            if (!mainWindow || mainWindow.isDestroyed()) {
              return;
            }
            mainWindow.webContents.send(IPC_CHANNELS.App.Initialization.Docker.Status, status);
            if (status.state === 'ready') {
              void (async () => {
                try {
                  const { getEngineSettings } = await import('./docker/embedded/engine-settings.js');
                  const settings = await getEngineSettings();
                  if (settings.kubernetes?.enabled) {
                    const { k8sManager } = await import('./k8s/k8s-manager.js');
                    await k8sManager.startCluster(settings.kubernetes);
                  }
                } catch (err) {
                  logger.warn({ err }, '[Main] Auto-start Kubernetes cluster encountered an issue.');
                }
              })();
            }
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
          logger.error({ err: error }, '[DockerConnection] Failed to initialize Docker service.');
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
          logger.info('Quitting application');
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
