import { logger } from '../../logger';
import type { DockerConnection } from '../types/connection.types';
import type {
  EngineCapabilities,
  EngineInfo,
  EngineProgressCallback,
  PlatformEngineDriver,
  PrerequisiteCheckResult
} from './types/engine.interface';
import type { EngineManifest } from './types/manifest.types';
import { WslEngineDriver } from './drivers/wsl-engine.driver';
import { LimaEngineDriver } from './drivers/lima-engine.driver';
import { RootlessEngineDriver } from './drivers/rootless-engine.driver';
import { EndpointRelay } from './endpoint-relay';
import { getEngineSettings, type EngineSettings } from './engine-settings';
import { CATBEE_EXPOSED_TCP_PORT } from './engine-paths';
import { connectionToUri } from './engine-utils';

export type EngineLifecycleState =
  'not-installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'uninstalling' | 'error';

export interface EngineOperationProgress {
  operation: 'install' | 'uninstall';
  /** 0-100 */
  progress: number;
  stage: string;
}

export type EngineOperationListener = (progress: EngineOperationProgress | null) => void;

export interface EngineStatusSnapshot {
  state: EngineLifecycleState;
  endpoint: string | null;
  exposedTcpEndpoint: string | null;
  lastError: string | null;
  /** The install/uninstall currently in flight, so late subscribers can render it. */
  operation: EngineOperationProgress | null;
  info: EngineInfo;
}

const BUSY_STATES = new Set<EngineLifecycleState>(['installing', 'starting', 'stopping', 'uninstalling']);
/** Downloads report per chunk; cap UI/IPC updates for the same percentage to a few per second. */
const PROGRESS_THROTTLE_MS = 250;

function createPlatformDriver(): PlatformEngineDriver {
  switch (process.platform) {
    case 'win32':
      return new WslEngineDriver();
    case 'darwin':
      return new LimaEngineDriver();
    default:
      return new RootlessEngineDriver();
  }
}

export class EngineManager {
  private readonly driver: PlatformEngineDriver;
  private currentState: EngineLifecycleState = 'not-installed';
  private lastConnection: DockerConnection | null = null;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lifecycleVersion = 0;
  private readonly tcpRelay = new EndpointRelay('expose-tcp');
  private currentOperation: EngineOperationProgress | null = null;
  private readonly operationListeners = new Set<EngineOperationListener>();

  constructor(customDriver?: PlatformEngineDriver) {
    this.driver = customDriver ?? createPlatformDriver();
  }

  get state(): EngineLifecycleState {
    return this.currentState;
  }

  get activeConnection(): DockerConnection | null {
    return this.lastConnection;
  }

  get endpointUri(): string | null {
    return this.lastConnection ? connectionToUri(this.lastConnection) : null;
  }

  get capabilities(): EngineCapabilities {
    return this.driver.getCapabilities();
  }

  getInfo(): EngineInfo {
    return this.driver.getInfo();
  }

  getSnapshot(): EngineStatusSnapshot {
    return {
      state: this.currentState,
      endpoint: this.endpointUri,
      exposedTcpEndpoint: this.tcpRelay.isRunning ? `tcp://127.0.0.1:${CATBEE_EXPOSED_TCP_PORT}` : null,
      lastError: this.lastError,
      operation: this.currentOperation,
      info: this.getInfo()
    };
  }

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    return await this.driver.checkPrerequisites();
  }

  async isInstalled(): Promise<boolean> {
    const version = this.lifecycleVersion;
    const installed = await this.driver.isInstalled();
    if (!installed && version === this.lifecycleVersion && !BUSY_STATES.has(this.currentState)) {
      this.currentState = 'not-installed';
    }
    return installed;
  }

  async getManifest(): Promise<EngineManifest | null> {
    return await this.driver.getManifest();
  }

  async getDaemonConfig(settings?: EngineSettings): Promise<Record<string, unknown>> {
    return await this.driver.buildDaemonConfig(settings ?? (await getEngineSettings()));
  }

  /** Subscribes to install/uninstall progress; `null` is emitted when the operation finishes. */
  onOperationProgress(listener: EngineOperationListener): () => void {
    this.operationListeners.add(listener);
    return () => this.operationListeners.delete(listener);
  }

  install(onProgress?: EngineProgressCallback): Promise<EngineManifest> {
    return this.exclusive(async () => {
      logger.info('[EngineManager] Installing built-in engine.');
      this.currentState = 'installing';
      this.lastError = null;
      const report = this.beginOperation('install', 'Preparing installation...', onProgress);
      try {
        const manifest = await this.driver.install(report);
        // Some backends (Lima) boot during install; reflect the real state.
        this.currentState = (await this.driver.getStatus()) === 'running' ? 'running' : 'stopped';
        return manifest;
      } catch (error) {
        this.fail(error, 'Installation failed.');
        throw error;
      } finally {
        this.endOperation();
      }
    });
  }

  start(onStatus?: (status: string) => void): Promise<DockerConnection> {
    return this.exclusive(() => this.startUnlocked(onStatus));
  }

  stop(): Promise<void> {
    return this.exclusive(() => this.stopUnlocked());
  }

  stopForShutdown(): Promise<void> {
    return this.exclusive(async () => {
      if (
        this.currentState === 'running' ||
        this.currentState === 'error' ||
        (await this.driver.getStatus()) === 'running'
      ) {
        this.currentState = 'running';
        await this.stopUnlocked();
      }
    });
  }

  restart(onStatus?: (status: string) => void): Promise<DockerConnection> {
    return this.exclusive(async () => {
      await this.stopUnlocked();
      return await this.startUnlocked(onStatus);
    });
  }

  /**
   * Re-applies settings to a running engine. Drivers diff their configuration and only restart
   * the daemon/VM when something actually changed.
   */
  applySettings(onStatus?: (status: string) => void): Promise<DockerConnection | null> {
    return this.exclusive(async () => {
      if (this.currentState !== 'running') {
        return null;
      }
      return await this.startUnlocked(onStatus);
    });
  }

  uninstall(onProgress?: EngineProgressCallback): Promise<void> {
    return this.exclusive(async () => {
      logger.info('[EngineManager] Uninstalling built-in engine.');
      this.currentState = 'uninstalling';
      const report = this.beginOperation('uninstall', 'Preparing to uninstall...', onProgress);
      try {
        await this.tcpRelay.stop();
        await this.driver.uninstall(report);
        this.lastConnection = null;
        this.lastError = null;
        this.currentState = 'not-installed';
      } catch (error) {
        this.fail(error, 'Uninstall failed.');
        throw error;
      } finally {
        this.endOperation();
      }
    });
  }

  async reclaimMemory(): Promise<void> {
    if (this.currentState === 'running') {
      await this.driver.reclaimMemory();
    }
  }

  async refreshStatus(): Promise<EngineLifecycleState> {
    if (BUSY_STATES.has(this.currentState)) {
      return this.currentState;
    }
    const version = this.lifecycleVersion;
    const driverStatus = await this.driver.getStatus();
    if (version !== this.lifecycleVersion) return this.currentState;
    if (driverStatus === 'stopped' && this.currentState === 'error') {
      return this.currentState;
    }
    this.currentState = driverStatus;
    if (driverStatus === 'running') {
      this.lastConnection ??= this.driver.getRunningConnection();
    } else {
      this.lastConnection = null;
    }
    return this.currentState;
  }

  async getInstalledWslDistros(): Promise<string[]> {
    return this.driver instanceof WslEngineDriver ? await this.driver.getInstalledDistros() : [];
  }

  configureWslDistroIntegration(distroName: string, enabled: boolean): Promise<boolean> {
    const driver = this.driver;
    if (!(driver instanceof WslEngineDriver)) return Promise.resolve(false);

    return this.exclusive(async () => {
      const requestedName = distroName.toLowerCase();
      const distro = (await driver.getInstalledDistros(true)).find(name => name.toLowerCase() === requestedName);
      return distro ? driver.configureWslDistroIntegration(distro, enabled) : false;
    });
  }

  applyWslIntegration(previous: EngineSettings, settings: EngineSettings, persist: () => Promise<void>): Promise<void> {
    const driver = this.driver;
    if (!(driver instanceof WslEngineDriver)) return persist();

    const enabledBefore = new Map(
      (previous.wslIntegrationEnabled ? previous.wslAdditionalDistros : []).map(name => [name.toLowerCase(), name])
    );
    const enabledAfter = new Map(
      (settings.wslIntegrationEnabled ? settings.wslAdditionalDistros : []).map(name => [name.toLowerCase(), name])
    );
    const changes = [...new Map([...enabledBefore, ...enabledAfter])].filter(
      ([key]) => enabledBefore.has(key) !== enabledAfter.has(key)
    );
    if (!changes.length) return persist();

    return this.exclusive(async () => {
      const installed = new Map((await driver.getInstalledDistros(true)).map(name => [name.toLowerCase(), name]));
      const applied: { distro: string; enabled: boolean }[] = [];
      try {
        for (const [key, name] of changes) {
          const enabled = enabledAfter.has(key);
          const distro = installed.get(key);
          if (!distro && !enabled) continue;
          if (!distro || !(await driver.configureWslDistroIntegration(distro, enabled))) {
            throw new Error(`Could not ${enabled ? 'enable' : 'disable'} Docker integration for "${name}".`);
          }
          applied.push({ distro, enabled });
        }
        await persist();
      } catch (error) {
        for (const { distro, enabled } of applied.reverse()) {
          if (!(await driver.configureWslDistroIntegration(distro, !enabled))) {
            logger.error(`[EngineManager] Could not restore Docker integration for "${distro}".`);
          }
        }
        throw error;
      }
    });
  }

  private async startUnlocked(onStatus?: (status: string) => void): Promise<DockerConnection> {
    logger.info('[EngineManager] Starting built-in engine.');
    this.currentState = 'starting';
    this.lastError = null;
    try {
      if (!(await this.isInstalled())) {
        throw new Error(
          'The built-in Docker Engine is not installed yet. Please install it first from Settings -> Docker Engine.'
        );
      }
      const settings = await getEngineSettings();
      const connection = await this.driver.start(settings, status => {
        logger.debug(`[EngineManager] ${status}`);
        onStatus?.(status);
      });
      this.lastConnection = connection;
      await this.syncTcpExposure(settings, connection);
      this.currentState = 'running';
      logger.info({ endpoint: connectionToUri(connection) }, '[EngineManager] Built-in engine is running.');
      return connection;
    } catch (error) {
      this.fail(error, 'Failed to start engine.');
      throw error;
    }
  }

  private async stopUnlocked(): Promise<void> {
    if (this.currentState === 'not-installed') {
      return;
    }
    logger.info('[EngineManager] Stopping built-in engine.');
    this.currentState = 'stopping';
    try {
      await this.tcpRelay.stop();
      await this.driver.stop();
      this.lastConnection = null;
      this.currentState = 'stopped';
    } catch (error) {
      this.fail(error, 'Failed to stop engine cleanly.');
      throw error;
    }
  }

  private async syncTcpExposure(settings: EngineSettings, connection: DockerConnection): Promise<void> {
    if (!settings.exposeTcp) {
      await this.tcpRelay.stop();
      return;
    }
    const ok = await this.tcpRelay.start({ type: 'tcp', host: '127.0.0.1', port: CATBEE_EXPOSED_TCP_PORT }, connection);
    if (!ok) {
      logger.warn(
        `[EngineManager] Port ${CATBEE_EXPOSED_TCP_PORT} is in use; the daemon is not exposed on tcp://localhost:${CATBEE_EXPOSED_TCP_PORT}.`
      );
    }
  }

  /**
   * Starts tracking an operation and returns a progress reporter. Progress never goes backwards,
   * and repeated updates at the same percentage are throttled (the latest stage is always flushed).
   */
  private beginOperation(
    operation: EngineOperationProgress['operation'],
    initialStage: string,
    onProgress?: EngineProgressCallback
  ): EngineProgressCallback {
    let lastEmitAt = 0;
    let pending: NodeJS.Timeout | null = null;

    const emit = (): void => {
      pending = null;
      lastEmitAt = Date.now();
      const snapshot = this.currentOperation;
      if (snapshot?.operation !== operation) {
        return;
      }
      onProgress?.(snapshot.progress, snapshot.stage);
      this.notifyOperationListeners(snapshot);
    };

    this.flushPendingOperation = () => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    };
    this.currentOperation = { operation, progress: 0, stage: initialStage };
    emit();

    return (progress, stage) => {
      const previous = this.currentOperation;
      if (previous?.operation !== operation) {
        return;
      }
      const next = {
        operation,
        progress: Math.max(previous.progress, Math.min(100, Math.round(progress))),
        stage: stage || previous.stage
      };
      if (next.progress === previous.progress && next.stage === previous.stage) {
        return;
      }
      this.currentOperation = next;
      logger.debug(`[EngineManager] ${operation} ${next.progress}%: ${next.stage}`);

      const elapsed = Date.now() - lastEmitAt;
      if (next.progress !== previous.progress || elapsed >= PROGRESS_THROTTLE_MS) {
        this.flushPendingOperation();
        emit();
      } else {
        pending ??= setTimeout(emit, PROGRESS_THROTTLE_MS - elapsed);
      }
    };
  }

  private flushPendingOperation: () => void = () => undefined;

  private endOperation(): void {
    this.flushPendingOperation();
    this.currentOperation = null;
    this.notifyOperationListeners(null);
  }

  private notifyOperationListeners(progress: EngineOperationProgress | null): void {
    for (const listener of this.operationListeners) {
      try {
        listener(progress);
      } catch (err) {
        logger.debug({ err }, '[EngineManager] Operation progress listener failed.');
      }
    }
  }

  private fail(error: unknown, message: string): void {
    this.currentState = 'error';
    this.lastError = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `[EngineManager] ${message}`);
  }

  /** Serializes lifecycle operations so concurrent start/stop/install calls cannot interleave. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const perform = (): Promise<T> => {
      this.lifecycleVersion++;
      return operation();
    };
    const run = this.queue.then(perform, perform);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const engineManager = new EngineManager();
