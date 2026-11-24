import { rm } from 'node:fs/promises';
import path from 'node:path';
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
import { getEngineSettings, resetEngineSettings, saveEngineSettings } from '../embedded/engine-settings';
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
import {
  connectionToUri,
  ensureHostDockerCli,
  removeShellPath,
  waitForHostDockerCliInstall
} from '../embedded/engine-utils';
import { getEngineRootDir, homeDir } from '../embedded/engine-paths';
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
  private readonly pausedContainersByEndpoint = new Map<string, string[]>();
  private lifecycleQueue: Promise<unknown> = Promise.resolve();

  private get pausedContainerIds(): string[] {
    return this.selectedRuntime
      ? (this.pausedContainersByEndpoint.get(connectionToUri(this.selectedRuntime.connection)) ?? [])
      : [];
  }

  private set pausedContainerIds(ids: string[]) {
    if (this.selectedRuntime) {
      this.pausedContainersByEndpoint.set(connectionToUri(this.selectedRuntime.connection), ids);
    }
  }

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
    return this.pausedContainerIds.length > 0;
  }

  getEnginePauseStatus(): { isPaused: boolean; pausedCount: number } {
    return {
      isPaused: this.isEnginePaused,
      pausedCount: this.pausedContainerIds.length
    };
  }

  initialize(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void,
    forceMode?: 'auto' | 'embedded' | 'external'
  ): Promise<void> {
    return this.withLifecycle(() => this.initializeRuntime(onStatus, onRuntimeStarted, forceMode));
  }

  private async initializeRuntime(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void,
    forceMode?: 'auto' | 'embedded' | 'external'
  ): Promise<void> {
    if (onStatus) {
      this.statusListener = onStatus;
    }

    // Ensure ~/.catbee/bin exists, is in user shell PATH, and hosts the standalone Docker CLI
    void ensureHostDockerCli().catch(err => {
      logger.debug('[DockerManager] Could not ensure host Docker CLI in background:', err);
    });

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
      this.initializeServices();
      await this.syncCliContext(this.selectedRuntime);

      this.emitStatus({
        state: 'ready',
        message: `${this.selectedRuntime.runtimeName} is ready.`,
        hint: 'Docker Engine is running and accessible.'
      });
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

  installEmbeddedEngine(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    return this.withLifecycle(() => this.installEmbeddedEngineUnlocked(onProgress));
  }

  private async installEmbeddedEngineUnlocked(onProgress?: (progress: number, stage: string) => void): Promise<void> {
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
      await this.initializeRuntime(this.statusListener, undefined, 'embedded');
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

  startEmbeddedEngine(): Promise<void> {
    return this.withLifecycle(() => this.startEmbeddedEngineUnlocked());
  }

  private async startEmbeddedEngineUnlocked(): Promise<void> {
    logger.info('[DockerManager] Explicitly starting embedded engine.');
    if (!(await engineManager.isInstalled())) {
      logger.info('[DockerManager] Embedded engine is not installed. Installing automatically.');
      await this.installEmbeddedEngineUnlocked();
      return;
    }
    await this.initializeRuntime(this.statusListener, undefined, 'embedded');
  }

  get isUsingEmbeddedEngine(): boolean {
    return this.selectedRuntime?.source === 'embedded';
  }

  stopEmbeddedEngine(): Promise<void> {
    return this.withLifecycle(() => this.stopEmbeddedEngineUnlocked());
  }

  private async stopEmbeddedEngineUnlocked(): Promise<void> {
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
      this.pausedContainerIds = [];
      this.selectedRuntime = null;
      this.emitStatus({
        state: 'error',
        message: 'CatBee Built-in Container Engine is stopped.',
        hint: 'Click "Start Engine" to resume container operations.'
      });
    });
  }

  restartEmbeddedEngine(mode?: 'auto' | 'embedded' | 'external'): Promise<void> {
    return this.withLifecycle(() => this.restartEmbeddedEngineUnlocked(mode));
  }

  private async restartEmbeddedEngineUnlocked(mode?: 'auto' | 'embedded' | 'external'): Promise<void> {
    const effectiveMode = mode ?? (await getEngineSettings()).engineMode;
    logger.info(`[DockerManager] Restarting engine with mode: ${effectiveMode}`);
    if (effectiveMode === 'embedded' && !(await engineManager.isInstalled())) {
      logger.info(
        '[DockerManager] Restart requested with embedded mode, but engine is not installed. Installing automatically.'
      );
      await this.installEmbeddedEngineUnlocked();
      return;
    }

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
        await engineManager.stop();
        if (this.isUsingEmbeddedEngine) this.pausedContainerIds = [];
      }
      await this.initializeRuntime(this.statusListener, undefined, effectiveMode);
    });
  }

  /** Applies saved settings to the running built-in engine (drivers only restart what changed). */
  applyEngineSettings(): Promise<{ applied: boolean }> {
    return this.withLifecycle(async () => {
      if (!this.isUsingEmbeddedEngine || engineManager.state !== 'running') return { applied: false };
      return this.withOperation('apply-settings', () => this.applyEngineSettingsUnlocked());
    });
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

  uninstallEmbeddedEngine(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    return this.withLifecycle(() => this.uninstallEmbeddedEngineUnlocked(onProgress));
  }

  private async uninstallEmbeddedEngineUnlocked(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    logger.info('[DockerManager] Uninstalling built-in engine.');
    const wasActive = this.isUsingEmbeddedEngine;
    if (wasActive) {
      resourceSaverManager.stop();
    }
    await waitForHostDockerCliInstall();
    await engineManager.uninstall(onProgress);
    if (wasActive) {
      this.pausedContainerIds = [];
      this.selectedRuntime = null;
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      await k8sManager.onEngineUninstall();
    }
    await removeCatBeeContext().catch(err => {
      logger.debug({ err }, '[DockerManager] Could not remove the catbee-desktop context.');
    });
    const settings = await getEngineSettings();
    if (settings.engineMode === 'embedded') {
      await saveEngineSettings({ engineMode: 'auto' });
    }
    if (wasActive) {
      await this.initializeRuntime(this.statusListener).catch(() => undefined);
    } else if (!this.selectedRuntime) {
      this.emitStatus({
        state: 'engine-not-installed',
        message: 'Container engine is not installed.',
        hint: 'The built-in engine was uninstalled.',
        prerequisitesOk: true
      });
    }
  }

  /**
   * Purges unused containers, dangling/unused images, build cache, and volumes.
   */
  async purgeData(): Promise<{
    containersPruned: number;
    imagesPruned: number;
    volumesPruned: number;
    spaceReclaimed: number;
  }> {
    logger.info('[DockerManager] Purging Docker data (containers, images, volumes, build cache)...');
    let containersPruned = 0;
    let imagesPruned = 0;
    let volumesPruned = 0;
    let spaceReclaimed = 0;

    if (this.client) {
      try {
        const containersRes = await this.client.pruneContainers();
        containersPruned = containersRes.ContainersDeleted?.length ?? 0;
        spaceReclaimed += containersRes.SpaceReclaimed ?? 0;
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to prune containers during purgeData.');
      }
      try {
        const imagesRes = await this.client.pruneImages({ dangling: false });
        imagesPruned = imagesRes.ImagesDeleted?.length ?? 0;
        spaceReclaimed += imagesRes.SpaceReclaimed ?? 0;
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to prune images during purgeData.');
      }
      try {
        const volumesRes = await this.client.pruneVolumes();
        volumesPruned = volumesRes.VolumesDeleted?.length ?? 0;
        spaceReclaimed += volumesRes.SpaceReclaimed ?? 0;
      } catch (err) {
        logger.warn({ err }, '[DockerManager] Failed to prune volumes during purgeData.');
      }
      try {
        const systemRes = await this.client.pruneBuilder();
        spaceReclaimed += systemRes.SpaceReclaimed ?? 0;
      } catch (err) {
        logger.debug({ err }, '[DockerManager] Failed to prune build cache during purgeData.');
      }
    }
    return { containersPruned, imagesPruned, volumesPruned, spaceReclaimed };
  }

  /**
   * Complete factory reset and teardown:
   * 1. Stops and deletes Kubernetes cluster companion and Kind cluster
   * 2. Uninstalls the embedded engine (Lima VM / WSL distro / Rootless kit)
   * 3. Resets Docker CLI context (removes catbee-desktop and falls back to default)
   * 4. Cleans Kubernetes context from kubeconfig
   * 5. Removes CatBee from system PATH (.zshrc, .bashrc, Windows User PATH)
   * 6. Deletes ~/.catbee folder, engine caches, and settings
   */
  async factoryResetTeardown(onProgress?: (progress: number, stage: string) => void): Promise<void> {
    logger.info('[DockerManager] Starting complete factory reset & teardown.');
    resourceSaverManager.stop();

    // 1. Kubernetes teardown
    onProgress?.(10, 'Stopping and deleting Kubernetes cluster...');
    try {
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      await k8sManager.stopCluster().catch(() => {});
      await k8sManager.cleanKubeconfig().catch(() => {});
    } catch (err) {
      logger.debug({ err }, '[DockerManager] K8s cleanup during teardown.');
    }
    this.selectedRuntime = null;

    // 2. Embedded engine uninstall
    onProgress?.(30, 'Uninstalling container engine and virtual disks...');
    await engineManager
      .uninstall((progress, stage) => {
        onProgress?.(30 + Math.round((progress * 35) / 100), stage);
      })
      .catch(err => {
        logger.warn({ err }, '[DockerManager] Engine uninstall during teardown.');
      });

    // 3. Docker context removal
    onProgress?.(70, 'Resetting Docker CLI contexts...');
    await removeCatBeeContext().catch(err => {
      logger.debug({ err }, '[DockerManager] Docker context cleanup during teardown.');
    });

    // 4. Shell PATH removal
    onProgress?.(80, 'Removing CatBee from system PATH...');
    await removeShellPath().catch(err => {
      logger.debug({ err }, '[DockerManager] Shell PATH cleanup during teardown.');
    });

    // 5. Delete ~/.catbee folder entirely
    onProgress?.(90, 'Removing application data and leftover directories...');
    const catbeeUserDir = path.join(homeDir(), '.catbee');
    await rm(catbeeUserDir, { recursive: true, force: true }).catch(() => {});

    // Delete engine root directory
    const engineRootDir = getEngineRootDir();
    await rm(engineRootDir, { recursive: true, force: true }).catch(() => {});

    // Delete config directory (~/.config/catbee)
    const configDir = path.join(homeDir(), '.config', 'catbee');
    await rm(configDir, { recursive: true, force: true }).catch(() => {});

    // 6. Reset saved settings to default
    await resetEngineSettings().catch(() => {});

    onProgress?.(100, 'Teardown complete.');
    this.emitStatus({
      state: 'engine-not-installed',
      message: 'Container engine is not installed.',
      hint: 'The built-in engine was completely removed.',
      prerequisitesOk: true
    });
    logger.info('[DockerManager] Complete factory reset & teardown finished.');
  }

  /** Stops the built-in engine when the app quits (external engines are left running). */
  shutdown(): Promise<void> {
    return this.withLifecycle(() => this.shutdownUnlocked(), false);
  }

  private async shutdownUnlocked(): Promise<void> {
    resourceSaverManager.stop();
    try {
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      await k8sManager.onAppQuit();
    } catch (err) {
      logger.debug('[DockerManager] Error shutting down k8sManager on quit:', err);
    }
    await engineManager.stopForShutdown();
    this.selectedRuntime = null;
  }

  pauseEngine(): Promise<{ pausedCount: number; isPaused: boolean }> {
    return this.withLifecycle(() => this.pauseEngineUnlocked(), false);
  }

  private async pauseEngineUnlocked(): Promise<{ pausedCount: number; isPaused: boolean }> {
    logger.info('[DockerManager] Pausing Docker Engine / containers.');
    if (!this.selectedRuntime) throw new Error('A Docker engine must be connected before pausing containers.');
    if (this.isEnginePaused) return this.getEnginePauseStatus();
    this.pausedContainerIds = [];
    const containers = await this.client.listContainers({ all: false });
    const running = containers.filter(c => c.State === 'running' || !c.State);
    const results = await Promise.allSettled(
      running.map(async c => {
        await this.client.getContainer(c.Id).pause();
        return c.Id;
      })
    );
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') this.pausedContainerIds.push(result.value);
      else errors.push(result.reason);
    }
    if (errors.length) {
      logger.warn({ errors }, '[DockerManager] Some containers could not be paused.');
      throw new AggregateError(errors, `Could not pause ${errors.length} container(s).`);
    }
    void resourceSaverManager.reclaimMemory();
    return this.getEnginePauseStatus();
  }

  resumeEngine(): Promise<{ resumedCount: number; isPaused: boolean }> {
    return this.withLifecycle(() => this.resumeEngineUnlocked(), false);
  }

  private async resumeEngineUnlocked(): Promise<{ resumedCount: number; isPaused: boolean }> {
    logger.info('[DockerManager] Resuming Docker Engine / containers.');
    if (!this.selectedRuntime) throw new Error('A Docker engine must be connected before resuming containers.');
    const owned = new Set(this.pausedContainerIds);
    const containers = await this.client.listContainers({ all: true });
    const targetIds = containers.filter(c => owned.has(c.Id) && c.State === 'paused').map(c => c.Id);
    const results = await Promise.allSettled(targetIds.map(id => this.client.getContainer(id).unpause()));
    this.pausedContainerIds = targetIds.filter((_id, index) => results[index].status === 'rejected');
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) {
      logger.warn({ errors }, '[DockerManager] Some containers could not be resumed.');
      throw new AggregateError(errors, `Could not resume ${errors.length} container(s). Retry Resume to try again.`);
    }
    return { resumedCount: results.length, isPaused: false };
  }

  switchContext(contextName: string): Promise<DockerContextDetails> {
    return this.withLifecycle(() => this.switchContextUnlocked(contextName));
  }

  async switchContext(contextName: string): Promise<DockerContextDetails> {
    logger.info(`[DockerManager] Switching Docker context to: ${contextName}`);

    const isCatBee = contextName === CATBEE_CONTEXT_NAME;
    let targetConnection: DockerConnection | null;

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

  private withLifecycle<T>(run: () => Promise<T>, reconcileKubernetes = true): Promise<T> {
    const operation = async (): Promise<T> => {
      const { k8sManager } = await import('../../k8s/k8s-manager.js');
      const resume = await k8sManager.suspendOperations();
      const previousStatus = this.latestStatus;
      try {
        return await run();
      } catch (error) {
        if (this.latestStatus && !['ready', 'error', 'engine-not-installed'].includes(this.latestStatus.state)) {
          this.emitStatus({
            state: 'error',
            message: 'Container engine operation failed.',
            hint: error instanceof Error ? error.message : String(error)
          });
        }
        throw error;
      } finally {
        resume();
        if (
          reconcileKubernetes &&
          this.selectedRuntime &&
          this.latestStatus !== previousStatus &&
          this.latestStatus?.state === 'ready'
        ) {
          void k8sManager.applyEnabledSetting().catch(error => {
            logger.warn({ err: error }, '[DockerManager] Could not reconcile Kubernetes with the active engine.');
          });
        }
      }
    };
    return this.queueLifecycleOperation(operation);
  }

  private queueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.catch(() => undefined);
    return result;
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
