import type Docker from 'dockerode';
import type { DockerInitializationStatus, SelectedDockerRuntime } from '../types/runtime.types';
import { createDockerClient } from '../docker.client';
import { DockerContainerService } from './docker.container.service';
import { DockerExecService } from './docker.exec.service';
import { DockerImageService } from './docker.image.service';
import { DockerNetworkService } from './docker.network.service';
import { DockerSystemService } from './docker.system.service';
import { DockerVolumeService } from './docker.volume.service';
import { DockerRuntimeManager } from '../runtime/docker.runtime-manager';
import { engineManager } from '../embedded/engine.manager';
import { saveEngineSettings } from '../embedded/engine-settings';
import {
  CATBEE_CONTEXT_NAME,
  getDockerContextInfo,
  resolveDockerContextConnection,
  setupCatBeeContext,
  useDockerContext,
  type DockerContextDetails
} from '../context/docker-context.manager';
import type { DockerConnection } from '../types/connection.types';
import { resourceSaverManager } from '../embedded/resource-saver.manager';
import { logger } from '../../logger';

export class DockerManager {
  private client!: Docker;
  private rendererReady = false;
  private latestStatus: DockerInitializationStatus | null = null;
  private statusListener?: (status: DockerInitializationStatus) => void;
  private selectedRuntime: SelectedDockerRuntime | null = null;
  private pausedContainerIds: string[] = [];
  private isPaused = false;

  private readonly runtimeManager = new DockerRuntimeManager();

  containers!: DockerContainerService;
  exec!: DockerExecService;
  images!: DockerImageService;
  networks!: DockerNetworkService;
  system!: DockerSystemService;
  volumes!: DockerVolumeService;

  get currentRuntime(): SelectedDockerRuntime | null {
    return this.selectedRuntime;
  }

  get isEnginePaused(): boolean {
    return this.isPaused;
  }

  getEnginePauseStatus(): { isPaused: boolean; pausedCount: number } {
    return {
      isPaused: this.isPaused,
      pausedCount: this.pausedContainerIds.length
    };
  }

  async initialize(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void,
    forceMode?: 'auto' | 'embedded' | 'external'
  ): Promise<void> {
    if (onStatus) {
      this.statusListener = onStatus;
    }

    this.emitStatus({
      state: 'checking',
      message: 'Checking Docker availability...',
      hint: 'Verifying if Docker Engine is running and accessible.'
    });

    try {
      this.selectedRuntime = await this.runtimeManager.ensureRuntime(
        status => this.emitStatus(status),
        onRuntimeStarted,
        forceMode
      );
      this.client = createDockerClient(this.selectedRuntime.connection);

      this.emitStatus({
        state: 'ready',
        message: `${this.selectedRuntime.runtimeName} is ready.`,
        hint: 'Docker Engine is running and accessible.'
      });

      this.initializeServices();
    } catch (error) {
      logger.warn({ err: error }, '[DockerManager] Docker initialization did not complete.');
      // If the runtime manager already emitted engine-not-installed or error, preserve that
      if (
        !this.latestStatus ||
        (this.latestStatus.state !== 'engine-not-installed' && this.latestStatus.state !== 'error')
      ) {
        this.emitStatus({
          state: 'error',
          message: 'Failed to connect to Docker Engine.',
          hint: error instanceof Error ? error.message : 'Please check your container engine configuration.'
        });
      }
      throw error;
    }
  }

  async installEmbeddedEngine(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    logger.info('[DockerManager] Installing embedded container engine.');
    this.emitStatus({
      state: 'installing-engine',
      progress: 0,
      stage: 'Preparing installation...',
      message: 'Setting up CatBee Built-in Container Engine...',
      hint: 'This may take a few moments.'
    });

    try {
      await engineManager.install((progress, stage) => {
        this.emitStatus({
          state: 'installing-engine',
          progress,
          stage,
          message: `Installing Built-in Engine (${progress}%)`,
          hint: stage
        });
        onProgress?.(progress, stage);
      });

      logger.info('[DockerManager] Embedded engine installed. Persisting embedded mode.');
      await saveEngineSettings({ engineMode: 'embedded' });

      logger.info('[DockerManager] Re-initializing DockerManager with embedded engine...');
      await this.initialize(this.statusListener, undefined, 'embedded');
    } catch (error) {
      logger.error({ err: error }, '[DockerManager] Failed to install embedded engine.');
      this.emitStatus({
        state: 'error',
        message: 'Failed to install Built-in Container Engine.',
        hint: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async startEmbeddedEngine(): Promise<void> {
    logger.info('[DockerManager] Explicitly starting embedded engine.');
    await this.initialize(this.statusListener, undefined, 'embedded');
  }

  async stopEmbeddedEngine(): Promise<void> {
    logger.info('[DockerManager] Stopping embedded engine.');
    resourceSaverManager.stop();
    await engineManager.stop();
    this.selectedRuntime = null;
    this.emitStatus({
      state: 'error',
      message: 'CatBee Built-in Container Engine is stopped.',
      hint: 'Click "Start Engine" to resume container operations.'
    });
  }

  async restartEmbeddedEngine(mode?: 'auto' | 'embedded' | 'external'): Promise<void> {
    logger.info(`[DockerManager] Restarting engine with mode: ${mode ?? 'configured'}`);
    this.pausedContainerIds = [];
    this.isPaused = false;
    await engineManager.stop();
    await this.initialize(this.statusListener, undefined, mode);
  }

  async pauseEngine(): Promise<{ pausedCount: number; isPaused: boolean }> {
    logger.info('[DockerManager] Pausing Docker Engine / containers.');
    this.pausedContainerIds = [];
    if (this.client) {
      try {
        const containers = await this.client.listContainers({ all: false });
        for (const c of containers) {
          if (c.State === 'running' || !c.State) {
            try {
              await this.client.getContainer(c.Id).pause();
              this.pausedContainerIds.push(c.Id);
            } catch (err) {
              logger.warn({ err, id: c.Id }, '[DockerManager] Failed to pause container during engine pause');
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to list containers during engine pause');
      }
    }
    this.isPaused = true;
    void resourceSaverManager.reclaimMemory();
    return { pausedCount: this.pausedContainerIds.length, isPaused: true };
  }

  async resumeEngine(): Promise<{ resumedCount: number; isPaused: boolean }> {
    logger.info('[DockerManager] Resuming Docker Engine / containers.');
    let count = 0;
    if (this.client) {
      try {
        if (this.pausedContainerIds.length > 0) {
          for (const id of this.pausedContainerIds) {
            try {
              await this.client.getContainer(id).unpause();
              count++;
            } catch (err) {
              logger.warn({ err, id }, '[DockerManager] Failed to unpause container during engine resume');
            }
          }
        } else {
          const allContainers = await this.client.listContainers({ all: true });
          for (const c of allContainers) {
            if (c.State === 'paused') {
              try {
                await this.client.getContainer(c.Id).unpause();
                count++;
              } catch (err) {
                logger.warn({ err, id: c.Id }, '[DockerManager] Failed to unpause container during engine resume');
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to list containers during engine resume');
      }
    }
    this.pausedContainerIds = [];
    this.isPaused = false;
    return { resumedCount: count, isPaused: false };
  }

  async switchContext(contextName: string): Promise<DockerContextDetails> {
    logger.info(`[DockerManager] Switching Docker context to: ${contextName}`);

    const isCatBee = contextName === CATBEE_CONTEXT_NAME;
    let targetConnection: DockerConnection | null = null;

    if (isCatBee) {
      targetConnection = await engineManager.start();
    } else {
      targetConnection = await resolveDockerContextConnection(contextName);
    }

    if (!targetConnection) {
      throw new Error(`Unable to resolve connection endpoint for Docker context "${contextName}".`);
    }

    // Ping test target engine before committing changes
    const testClient = createDockerClient(targetConnection);
    try {
      await testClient.ping();
    } catch (err) {
      logger.error(
        { err, contextName, connection: targetConnection },
        '[DockerManager] Failed to ping context endpoint.'
      );
      throw new Error(
        `Cannot connect to Docker daemon for context "${contextName}". Please make sure the container engine is running.`
      );
    }

    // Swap client and re-initialize services
    this.client = testClient;
    this.initializeServices();
    this.selectedRuntime = {
      source: isCatBee ? 'embedded' : 'external',
      runtimeName: contextName,
      connection: targetConnection
    };

    // Save mode preference
    await saveEngineSettings({ engineMode: isCatBee ? 'embedded' : 'external' });

    // Switch context in Docker CLI if available
    let details: DockerContextDetails;
    try {
      if (isCatBee) {
        const info = await getDockerContextInfo();
        if (!info.catbeeContextExists) {
          await setupCatBeeContext(false);
        }
      }
      details = await useDockerContext(contextName);
    } catch (cliErr) {
      logger.debug({ cliErr }, '[DockerManager] Docker CLI context activation skipped or failed.');
      details = await getDockerContextInfo();
    }

    this.emitStatus({
      state: 'ready',
      message: `${contextName} is active.`,
      hint: isCatBee
        ? 'CatBee Built-in Container Engine is ready.'
        : `Connected to Docker via context "${contextName}".`
    });

    return details;
  }

  private initializeServices(): void {
    this.containers = new DockerContainerService(this.client);
    this.exec = new DockerExecService(this.client);
    this.images = new DockerImageService(this.client);
    this.networks = new DockerNetworkService(this.client);
    this.system = new DockerSystemService(this.client);
    this.volumes = new DockerVolumeService(this.client, this.containers, this.images);

    resourceSaverManager.start(async () => {
      try {
        const list = await this.client.listContainers({ all: false });
        return list.length;
      } catch {
        return null;
      }
    });
  }

  setRendererReady(): void {
    this.rendererReady = true;
    if (this.latestStatus) {
      this.statusListener?.(this.latestStatus);
    }
  }

  private emitStatus(status: DockerInitializationStatus): void {
    this.latestStatus = status;
    if (this.rendererReady) {
      this.statusListener?.(status);
    }
  }
}

export const dockerManager = new DockerManager();
