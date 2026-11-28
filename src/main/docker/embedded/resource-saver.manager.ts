import { logger as appLogger } from '../../logger';
import { getEngineSettings } from './engine-settings';
import { engineManager } from './engine.manager';

const logger = appLogger.child({}, { msgPrefix: '[ResourceSaver] ' });

export class ResourceSaverManager {
  private timer: NodeJS.Timeout | null = null;
  private idleSeconds = 0;
  private inSaverMode = false;
  private isChecking = false;

  start(getRunningContainerCount: () => Promise<number | null>): void {
    if (this.timer || !engineManager.capabilities.resourceSaver) {
      return;
    }

    logger.debug('Starting Resource Saver background monitor.');
    this.timer = setInterval(async () => {
      if (this.isChecking) return;
      this.isChecking = true;

      try {
        const settings = await getEngineSettings();
        if (!settings.resourceSaverEnabled || settings.engineMode === 'external') {
          if (this.inSaverMode) {
            this.inSaverMode = false;
            this.idleSeconds = 0;
          }
          return;
        }

        const runningCount = await getRunningContainerCount();
        if (runningCount === null) {
          return;
        }

        if (runningCount === 0) {
          this.idleSeconds += 10;
          if (this.idleSeconds >= settings.resourceSaverTimeout && !this.inSaverMode) {
            this.inSaverMode = true;
            logger.info(
              `No containers running for ${this.idleSeconds}s (threshold: ${settings.resourceSaverTimeout}s). Triggering memory and CPU reclamation.`
            );
            await this.reclaimMemory();
          }
        } else {
          if (this.inSaverMode) {
            logger.debug('Active containers detected. Exiting Resource Saver mode.');
            this.inSaverMode = false;
          }
          this.idleSeconds = 0;
        }
      } catch (err) {
        logger.debug({ err }, 'Check error:');
      } finally {
        this.isChecking = false;
      }
    }, 10000);
  }

  async reclaimMemory(): Promise<void> {
    try {
      await engineManager.reclaimMemory();
      logger.debug('Reclaimed engine memory.');
    } catch (err) {
      logger.debug({ err }, 'Memory reclamation skipped.');
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.inSaverMode = false;
    this.idleSeconds = 0;
  }
}

export const resourceSaverManager = new ResourceSaverManager();
