import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createDockerClient } from '../docker.client';
import {
  resolveExternalDockerConnection,
  DockerConnectionError,
  getCurrentDockerContextName
} from '../docker.connection';
import { getDockerCliPath, getRdctlPath, startDockerRuntime } from './docker.runtime';
import { engineManager } from '../embedded/engine.manager';
import { logger as appLogger } from '../../logger';
import { getEngineSettings, type EngineMode } from '../embedded/engine-settings';
import type { DockerInitializationStatus, DockerRuntimeInfo, SelectedDockerRuntime } from '../types/runtime.types';
import type { DockerConnection } from '../types/connection.types';

const logger = appLogger.child({}, { msgPrefix: '[DockerRuntime] ' });

const execFileAsync = promisify(execFile);

export class DockerRuntimeManager {
  /**
   * Discovers and ensures a Docker runtime is available following the configured mode:
   * - 'embedded': Directly launches and connects to CatBee's built-in container engine.
   * - 'external': Only connects to host-installed Docker Desktop / Rancher Desktop / system socket.
   * - 'auto': External first, falling back to embedded if no external runtime is active.
   */
  async ensureRuntime(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void,
    forceMode?: EngineMode
  ): Promise<SelectedDockerRuntime> {
    const settings = await getEngineSettings();
    const mode = forceMode ?? settings.engineMode ?? 'auto';
    logger.debug(`Resolving Docker runtime using mode: ${mode}`);

    if (mode === 'embedded') {
      return await this.ensureEmbeddedRuntime(onStatus);
    }

    if (mode === 'external') {
      return await this.ensureExternalOnlyRuntime(onStatus, onRuntimeStarted);
    }

    // mode === 'auto': External-first if active, otherwise prefer installed embedded engine
    logger.debug('Resolving external Docker connection first.');

    // 1. Check if an external Docker engine is already responding
    onStatus?.({
      state: 'checking',
      message: 'Checking Docker availability...',
      hint: 'Verifying if Docker Engine is running and accessible.'
    });

    const activeExternal = await resolveExternalDockerConnection();
    if (activeExternal) {
      try {
        const client = createDockerClient(activeExternal);
        await client.ping();
        logger.debug('Active external Docker engine is ready.');
        return {
          source: 'external',
          runtimeName: activeExternal.source,
          connection: activeExternal
        };
      } catch {
        logger.debug('External connection was resolved but ping failed.');
      }
    }

    // 2. If no external engine is actively responding, check if CatBee's built-in engine is installed
    const isEmbeddedInstalled = await engineManager.isInstalled();
    if (isEmbeddedInstalled) {
      logger.debug('No active external Docker engine; starting installed embedded engine.');
      return await this.ensureEmbeddedRuntime(onStatus);
    }

    // 3. If embedded engine is not installed, check if an external desktop runtime can be started
    onStatus?.({
      state: 'detecting-runtime',
      message: 'Detecting container runtime...',
      hint: 'Looking for an available Docker runtime.'
    });

    const externalInfo = await this.detectExternalRuntime();
    if (externalInfo) {
      logger.debug(`Starting detected external runtime: ${externalInfo.runtime}`);
      const runtimeName = externalInfo.runtime === 'rancher-desktop' ? 'Rancher Desktop' : 'Docker Desktop';
      onStatus?.({
        state: 'starting-runtime',
        runtime: externalInfo.runtime,
        message: `Starting ${runtimeName}...`,
        hint: `${runtimeName} is starting. This may take a few moments.`
      });

      try {
        await startDockerRuntime(externalInfo);
        onRuntimeStarted?.();
        const connection = await this.waitForExternalDocker(onStatus);
        return {
          source: 'external',
          runtimeName,
          connection,
          runtimeInfo: externalInfo
        };
      } catch (error) {
        logger.warn(
          { err: error },
          `Failed to start external runtime ${runtimeName}. Falling back to embedded engine.`
        );
      }
    }

    // 4. Fallback to CatBee's Embedded Engine prompt/prerequisites
    logger.debug('No external Docker engine available. Checking embedded engine.');
    return await this.ensureEmbeddedRuntime(onStatus);
  }

  private async ensureExternalOnlyRuntime(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void
  ): Promise<SelectedDockerRuntime> {
    onStatus?.({
      state: 'checking',
      message: 'Checking external Docker availability...',
      hint: 'Looking for host Docker daemon or desktop runtime.'
    });

    const activeExternal = await resolveExternalDockerConnection();
    if (activeExternal) {
      try {
        const client = createDockerClient(activeExternal);
        await client.ping();
        logger.debug('Active external Docker engine is ready.');
        return {
          source: 'external',
          runtimeName: activeExternal.source,
          connection: activeExternal
        };
      } catch {
        logger.debug('External connection was resolved but ping failed.');
      }
    }

    const externalInfo = await this.detectExternalRuntime();
    if (externalInfo) {
      const runtimeName = externalInfo.runtime === 'rancher-desktop' ? 'Rancher Desktop' : 'Docker Desktop';
      onStatus?.({
        state: 'starting-runtime',
        runtime: externalInfo.runtime,
        message: `Starting ${runtimeName}...`,
        hint: `${runtimeName} is starting. This may take a few moments.`
      });

      try {
        await startDockerRuntime(externalInfo);
        onRuntimeStarted?.();
        const connection = await this.waitForExternalDocker(onStatus);
        return {
          source: 'external',
          runtimeName,
          connection,
          runtimeInfo: externalInfo
        };
      } catch {
        throw new Error(`Failed to start external container engine (${runtimeName}).`);
      }
    }

    throw new DockerConnectionError(
      'No external Docker engine was found running on your host system. Please start Docker Desktop or switch to CatBee Built-in engine.'
    );
  }

  private async ensureEmbeddedRuntime(
    onStatus?: (status: DockerInitializationStatus) => void
  ): Promise<SelectedDockerRuntime> {
    const isInstalled = await engineManager.isInstalled();

    if (!isInstalled) {
      logger.info('Built-in engine is not installed.');
      const prereq = await engineManager.checkPrerequisites();

      onStatus?.({
        state: 'engine-not-installed',
        message: 'No Container Engine Found',
        hint: 'CatBee can set up an isolated, built-in container engine for you without requiring Docker Desktop.',
        prerequisitesOk: prereq.ok,
        reason: prereq.reason,
        actionHint: prereq.actionHint
      });

      throw new DockerConnectionError('No container runtime is available. Built-in engine is not installed.');
    }

    // User recommendation #3: If installed but stopped, automatically start it
    logger.debug('Embedded engine is installed. Starting background engine.');
    onStatus?.({
      state: 'starting-runtime',
      runtime: 'catbee-embedded',
      message: 'Starting CatBee Container Engine...',
      hint: 'Launching background container service.'
    });

    try {
      const connection = await engineManager.start(statusMsg => {
        onStatus?.({
          state: 'waiting-for-engine',
          message: 'Establishing connection to container daemon.',
          hint: statusMsg
        });
      });

      const client = createDockerClient(connection);
      await client.ping();

      logger.debug('CatBee embedded engine is ready.');
      return {
        source: 'embedded',
        runtimeName: 'CatBee Built-in Engine',
        connection
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to start CatBee embedded engine.');
      onStatus?.({
        state: 'error',
        message: 'Failed to start CatBee Container Engine.',
        hint: error instanceof Error ? error.message : 'Try restarting the application.'
      });
      throw error;
    }
  }

  private async detectExternalRuntime(): Promise<DockerRuntimeInfo | null> {
    logger.debug('Detecting external Docker desktop runtimes.');

    const dockerPath = await getDockerCliPath();
    if (dockerPath) {
      const context = await getCurrentDockerContextName(dockerPath);
      if (context === 'rancher-desktop') {
        const rdctlPath = await getRdctlPath();
        if (rdctlPath) {
          return {
            runtime: 'rancher-desktop',
            executablePath: rdctlPath
          };
        }
      }

      const dockerDesktop = await this.detectDockerDesktop(dockerPath);
      if (dockerDesktop) {
        return dockerDesktop;
      }
    }

    const rdctlPath = await getRdctlPath();
    if (rdctlPath) {
      return {
        runtime: 'rancher-desktop',
        executablePath: rdctlPath
      };
    }

    return null;
  }

  private async detectDockerDesktop(dockerPath: string): Promise<DockerRuntimeInfo | null> {
    try {
      await execFileAsync(dockerPath, ['desktop', 'version'], {
        encoding: 'utf8',
        windowsHide: true
      });
      return {
        runtime: 'docker-desktop',
        executablePath: dockerPath
      };
    } catch {
      return null;
    }
  }

  private async waitForExternalDocker(
    onStatus?: (status: DockerInitializationStatus) => void
  ): Promise<DockerConnection> {
    const timeout = 120_000;
    const interval = 1_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const active = await resolveExternalDockerConnection();
      if (active) {
        try {
          const client = createDockerClient(active);
          await client.ping();
          return active;
        } catch {
          // Keep waiting
        }
      }

      onStatus?.({
        state: 'waiting-for-engine',
        message: 'Waiting for Docker Engine...',
        hint: 'Docker Engine is starting. Your workspace will be ready shortly.'
      });

      await new Promise(resolve => setTimeout(resolve, interval));
    }

    throw new DockerConnectionError('External Docker runtime started, but engine did not become ready.');
  }
}
