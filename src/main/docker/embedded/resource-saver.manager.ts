import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../logger';
import { getEngineSettings } from './engine-settings';

const execFileAsync = promisify(execFile);

export class ResourceSaverManager {
  private timer: NodeJS.Timeout | null = null;
  private idleSeconds = 0;
  private inSaverMode = false;
  private isChecking = false;

  start(getRunningContainerCount: () => Promise<number | null>): void {
    if (this.timer) {
      return;
    }

    logger.info('[ResourceSaver] Starting Resource Saver background monitor.');
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
              `[ResourceSaver] No containers running for ${this.idleSeconds}s (threshold: ${settings.resourceSaverTimeout}s). Triggering memory and CPU reclamation.`
            );
            await this.reclaimMemory();
          }
        } else {
          if (this.inSaverMode) {
            logger.info('[ResourceSaver] Active containers detected. Exiting Resource Saver mode.');
            this.inSaverMode = false;
          }
          this.idleSeconds = 0;
        }
      } catch (err) {
        logger.debug({ err }, '[ResourceSaver] Check error:');
      } finally {
        this.isChecking = false;
      }
    }, 10000);
  }

  async reclaimMemory(): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await execFileAsync(
          'wsl.exe',
          [
            '-d',
            'catbee-container-engine',
            '-u',
            'root',
            '--',
            'sh',
            '-c',
            'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory 2>/dev/null || true'
          ],
          { windowsHide: true }
        );
        logger.debug('[ResourceSaver] Dropped WSL2 caches and compacted memory.');
      } catch {
        // Distro might not be running
      }
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
