import type Docker from 'dockerode';
import type { DockerInitializationStatus, EngineStatusOperation, SelectedDockerRuntime } from '../types/runtime.types';
import { createDockerClient } from '../docker.client';
import { DockerContainerService } from './docker.container.service';
import { DockerExecService } from './docker.exec.service';
import { DockerImageService } from './docker.image.service';
import { DockerNetworkService } from './docker.network.service';
import { DockerSystemService } from './docker.system.service';
import { DockerVolumeService } from './docker.volume.service';
import { DockerRuntimeManager } from '../runtime/docker.runtime-manager';
import { engineManager } from '../embedded/engine.manager';
import { getEngineSettings, saveEngineSettings } from '../embedded/engine-settings';
import {
  activateCatBeeEngineContext,
  CATBEE_CONTEXT_NAME,
  getDockerContextInfo,
  releaseCatBeeContext,
  removeCatBeeContext,
  resolveDockerContextConnection,
  setupCatBeeContext,
  useDockerContext,
  type DockerContextDetails
} from '../context/docker-context.manager';
import { connectionToUri } from '../embedded/engine-utils';
import { proxyToEnv, resolveContainersProxy } from '../embedded/daemon-config';
import { detectSystemProxy } from '../embedded/system-proxy';
import type { DockerConnection } from '../types/connection.types';
import { resourceSaverManager } from '../embedded/resource-saver.manager';
import { logger } from '../../logger';

export class DockerManager {
  private client!: Docker;
  private rendererReady = false;
  private latestStatus: DockerInitializationStatus | null = null;
  private currentOperation: EngineStatusOperation | null = null;
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
      await this.syncCliContext(this.selectedRuntime);

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

  get isUsingEmbeddedEngine(): boolean {
    return this.selectedRuntime?.source === 'embedded';
  }

  async stopEmbeddedEngine(): Promise<void> {
    logger.info('[DockerManager] Stopping embedded engine.');
    const wasActive = this.isUsingEmbeddedEngine;
    if (!wasActive) {
      // CatBee is on another engine; stopping the idle built-in one must not touch the app-wide status.
      await engineManager.stop();
      return;
    }
    await this.withOperation('stop', async () => {
      resourceSaverManager.stop();
      this.emitStatus({
        state: 'stopping-engine',
        message: 'Stopping Docker Engine...',
        hint: 'Shutting down the CatBee Built-in Container Engine.'
      });
      try {
        await engineManager.stop();
      } catch (error) {
        this.emitStatus({
          state: 'error',
          message: 'Failed to stop the built-in engine.',
          hint: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      this.selectedRuntime = null;
      this.emitStatus({
        state: 'error',
        message: 'CatBee Built-in Container Engine is stopped.',
        hint: 'Click "Start Engine" to resume container operations.'
      });
    });
  }

  async restartEmbeddedEngine(mode?: 'auto' | 'embedded' | 'external'): Promise<void> {
    const effectiveMode = mode ?? (await getEngineSettings()).engineMode;
    logger.info(`[DockerManager] Restarting engine with mode: ${effectiveMode}`);
    this.pausedContainerIds = [];
    this.isPaused = false;

    await this.withOperation('restart', async () => {
      // Only touch the built-in engine when it is running; an external engine is never stopped by CatBee.
      if (engineManager.state === 'running' || engineManager.state === 'error') {
        if (this.isUsingEmbeddedEngine) {
          resourceSaverManager.stop();
        }
        this.emitStatus({
          state: 'stopping-engine',
          message: 'Restarting Docker Engine...',
          hint: 'Stopping the engine before starting it again.'
        });
        await engineManager.stop().catch(err => {
          logger.warn({ err }, '[DockerManager] Built-in engine did not stop cleanly; continuing.');
        });
      }
      await this.initialize(this.statusListener, undefined, effectiveMode);
    });
  }

  /** Applies saved settings to the running built-in engine (drivers only restart what changed). */
  async applyEngineSettings(): Promise<{ applied: boolean }> {
    if (!this.isUsingEmbeddedEngine || engineManager.state !== 'running') {
      return { applied: false };
    }
    return await this.withOperation('apply-settings', () => this.applyEngineSettingsUnlocked());
  }

  private async applyEngineSettingsUnlocked(): Promise<{ applied: boolean }> {
    this.emitStatus({
      state: 'waiting-for-engine',
      message: 'Applying engine settings...',
      hint: 'The container engine may restart to apply the new configuration.'
    });
    try {
      const connection = await engineManager.applySettings(status =>
        this.emitStatus({ state: 'waiting-for-engine', message: 'Applying engine settings...', hint: status })
      );
      if (connection) {
        this.client = createDockerClient(connection);
        this.selectedRuntime = { source: 'embedded', runtimeName: 'CatBee Built-in Engine', connection };
        this.initializeServices();
        await activateCatBeeEngineContext(connection);
      }
      this.emitStatus({
        state: 'ready',
        message: 'CatBee Built-in Engine is ready.',
        hint: 'Settings applied.'
      });
      return { applied: true };
    } catch (error) {
      this.emitStatus({
        state: 'error',
        message: 'Failed to apply engine settings.',
        hint: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async uninstallEmbeddedEngine(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    logger.info('[DockerManager] Uninstalling built-in engine.');
    const wasActive = this.isUsingEmbeddedEngine;
    if (wasActive) {
      resourceSaverManager.stop();
      this.selectedRuntime = null;
    }
    await engineManager.uninstall(onProgress);
    try {
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      await k8sManager.onEngineUninstall();
    } catch {
      // Ignore if K8s module is not loaded
    }
    await removeCatBeeContext().catch(err => {
      logger.debug({ err }, '[DockerManager] Could not remove the catbee-desktop context.');
    });
    const settings = await getEngineSettings();
    if (settings.engineMode === 'embedded') {
      await saveEngineSettings({ engineMode: 'auto' });
    }
    if (wasActive) {
      await this.initialize(this.statusListener).catch(() => undefined);
    }
  }

  /** Stops the built-in engine when the app quits (external engines are left running). */
  async shutdown(): Promise<void> {
    resourceSaverManager.stop();
    try {
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      await k8sManager.onAppQuit();
    } catch (err) {
      logger.debug('[DockerManager] Error shutting down k8sManager on quit:', err);
    }
    if (['running', 'starting', 'error'].includes(engineManager.state)) {
      await engineManager.stop();
    }
  }

  async pauseEngine(): Promise<{ pausedCount: number; isPaused: boolean }> {
    logger.info('[DockerManager] Pausing Docker Engine / containers.');
    this.pausedContainerIds = [];
    if (this.client) {
      try {
        const containers = await this.client.listContainers({ all: false });
        const running = containers.filter(c => c.State === 'running' || !c.State);
        const results = await Promise.allSettled(
          running.map(async c => {
            await this.client!.getContainer(c.Id).pause();
            return c.Id;
          })
        );
        for (const res of results) {
          if (res.status === 'fulfilled') {
            this.pausedContainerIds.push(res.value);
          } else {
            logger.warn({ err: res.reason }, '[DockerManager] Failed to pause container during engine pause');
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
        const targetIds = await this.resolveContainersToResume();
        const results = await Promise.allSettled(targetIds.map(id => this.client!.getContainer(id).unpause()));
        count = results.filter(r => r.status === 'fulfilled').length;
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to list or unpause containers during engine resume');
      }
    }
    this.pausedContainerIds = [];
    this.isPaused = false;
    return { resumedCount: count, isPaused: false };
  }

  private async resolveContainersToResume(): Promise<string[]> {
    if (this.pausedContainerIds.length > 0) {
      return this.pausedContainerIds;
    }
    const allContainers = await this.client!.listContainers({ all: true });
    return allContainers.filter(c => c.State === 'paused').map(c => c.Id);
  }

  async switchContext(contextName: string): Promise<DockerContextDetails> {
    logger.info(`[DockerManager] Switching Docker context to: ${contextName}`);

    const isCatBee = contextName === CATBEE_CONTEXT_NAME;
    let targetConnection: DockerConnection | null = null;

    if (isCatBee) {
      if (!(await engineManager.isInstalled())) {
        logger.info('[DockerManager] Built-in engine not installed; installing before switching context...');
        await engineManager.install();
      }
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
      details = isCatBee
        ? await setupCatBeeContext(true, connectionToUri(targetConnection))
        : await useDockerContext(contextName);
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

  /** Keeps the global Docker CLI on the engine CatBee uses (done before "ready" so the UI reads the new context). */
  private async syncCliContext(runtime: SelectedDockerRuntime): Promise<void> {
    if (runtime.source === 'embedded') {
      await activateCatBeeEngineContext(runtime.connection);
    } else {
      await releaseCatBeeContext(runtime.connection);
    }
  }

  private initializeServices(): void {
    this.containers = new DockerContainerService(this.client, () => this.getContainerEnvDefaults());
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

  /** "Containers proxy" variables for containers the app creates (the Docker CLI gets them via config.json). */
  private async getContainerEnvDefaults(): Promise<Record<string, string>> {
    if (!this.isUsingEmbeddedEngine) return {};
    const settings = await getEngineSettings();
    if (settings.containersProxy.mode === 'none') return {};
    return proxyToEnv(resolveContainersProxy(settings, await detectSystemProxy()));
  }

  setRendererReady(): void {
    this.rendererReady = true;
    if (this.latestStatus) {
      this.statusListener?.(this.latestStatus);
    }
  }

  private async withOperation<T>(operation: EngineStatusOperation, run: () => Promise<T>): Promise<T> {
    this.currentOperation = operation;
    try {
      return await run();
    } finally {
      this.currentOperation = null;
    }
  }

  private emitStatus(rawStatus: DockerInitializationStatus): void {
    // Outcome states describe the result, not the operation that produced it.
    const isOutcome = ['ready', 'error', 'engine-not-installed'].includes(rawStatus.state);
    const status: DockerInitializationStatus =
      this.currentOperation && !isOutcome ? { ...rawStatus, operation: this.currentOperation } : rawStatus;
    this.latestStatus = status;
    if (this.rendererReady) {
      this.statusListener?.(status);
    }
  }
}

export const dockerManager = new DockerManager();
