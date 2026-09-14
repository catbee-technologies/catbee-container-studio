import { logger } from '../../logger';
import type { DockerConnection } from '../types/connection.types';
import type { PlatformEngineDriver, PrerequisiteCheckResult } from './types/engine.interface';
import type { EngineManifest } from './types/manifest.types';
import { WslEngineDriver } from './drivers/wsl-engine.driver';
import { VzEngineDriver } from './drivers/vz-engine.driver';
import { RootlessEngineDriver } from './drivers/rootless-engine.driver';

export type EngineLifecycleState =
  'not-installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export class EngineManager {
  private readonly driver: PlatformEngineDriver;
  private currentState: EngineLifecycleState = 'not-installed';
  private lastConnection: DockerConnection | null = null;

  constructor(customDriver?: PlatformEngineDriver) {
    if (customDriver) {
      this.driver = customDriver;
    } else {
      switch (process.platform) {
        case 'win32':
          this.driver = new WslEngineDriver();
          break;
        case 'darwin':
          this.driver = new VzEngineDriver();
          break;
        default:
          this.driver = new RootlessEngineDriver();
          break;
      }
    }
  }

  get state(): EngineLifecycleState {
    return this.currentState;
  }

  get activeConnection(): DockerConnection | null {
    return this.lastConnection;
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    return await this.driver.checkPrerequisites();
  }

  async isInstalled(): Promise<boolean> {
    const installed = await this.driver.isInstalled();
    if (!installed && this.currentState !== 'installing') {
      this.currentState = 'not-installed';
    }
    return installed;
  }

  async getManifest(): Promise<EngineManifest | null> {
    return await this.driver.getManifest();
  }

  async install(onProgress?: (progress: number, stage: string) => void): Promise<EngineManifest> {
    logger.info('[EngineManager] Initiating embedded engine installation.');
    this.currentState = 'installing';

    try {
      const manifest = await this.driver.install((progress, stage) => {
        logger.debug(`[EngineManager] Install progress: ${progress}% - ${stage}`);
        onProgress?.(progress, stage);
      });

      this.currentState = 'stopped';
      logger.info('[EngineManager] Embedded engine installation completed.');
      return manifest;
    } catch (error) {
      this.currentState = 'error';
      logger.error({ err: error }, '[EngineManager] Installation failed.');
      throw error;
    }
  }

  async start(onStatus?: (status: string) => void): Promise<DockerConnection> {
    logger.info('[EngineManager] Starting embedded engine.');
    this.currentState = 'starting';

    try {
      const connection = await this.driver.start(status => {
        logger.debug(`[EngineManager] Start status: ${status}`);
        onStatus?.(status);
      });

      this.lastConnection = connection;
      this.currentState = 'running';
      logger.info({ connection }, '[EngineManager] Embedded engine is running.');
      return connection;
    } catch (error) {
      this.currentState = 'error';
      logger.error({ err: error }, '[EngineManager] Failed to start engine.');
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('[EngineManager] Stopping embedded engine.');
    this.currentState = 'stopping';

    try {
      await this.driver.stop();
      this.currentState = 'stopped';
      this.lastConnection = null;
      logger.info('[EngineManager] Embedded engine stopped.');
    } catch (error) {
      this.currentState = 'error';
      logger.error({ err: error }, '[EngineManager] Failed to stop engine cleanly.');
      throw error;
    }
  }

  async restart(onStatus?: (status: string) => void): Promise<DockerConnection> {
    logger.info('[EngineManager] Restarting embedded engine.');
    await this.stop();
    return await this.start(onStatus);
  }

  async refreshStatus(): Promise<EngineLifecycleState> {
    const driverStatus = await this.driver.getStatus();
    this.currentState = driverStatus;
    return this.currentState;
  }

  async getInstalledWslDistros(): Promise<string[]> {
    if (this.driver instanceof WslEngineDriver) {
      return await this.driver.getInstalledDistros();
    }
    return [];
  }

  async configureWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    if (this.driver instanceof WslEngineDriver) {
      return await this.driver.configureWslDistroIntegration(distroName, enabled);
    }
    return false;
  }
}

export const engineManager = new EngineManager();
