import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import Docker from 'dockerode';
import { createDockerClient } from './docker.client';
import { DockerConnectionError } from './docker.connection';
import {
  DockerInitializationStatus,
  DockerRuntimeInfo,
  getDockerCliPath,
  getRdctlPath,
  startDockerRuntime
} from './docker.runtime';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export class DockerRuntimeManager {
  async ensureDockerAvailable(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void
  ): Promise<Docker> {
    logger.debug('[DockerRuntime] Checking Docker availability.');
    try {
      const client = await createDockerClient();
      await client.ping();
      logger.info('[DockerRuntime] Docker is already available.');
      return client;
    } catch (error) {
      logger.debug(`[DockerRuntime] Docker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    onStatus?.({
      state: 'detecting-runtime',
      message: 'Detecting container runtime...',
      hint: 'Looking for an available Docker runtime.'
    });
    const runtimeInfo = await this.detectRuntime();
    if (!runtimeInfo) {
      onStatus?.({
        state: 'error',
        message: 'No supported container runtime was detected.',
        hint: 'Please install Docker Desktop or Rancher Desktop to manage containers.'
      });
      throw new DockerConnectionError('Docker is not available and no supported container runtime was detected.');
    }
    logger.info(`[DockerRuntime] Starting detected runtime: ${runtimeInfo.runtime}`);
    const runtimeName = runtimeInfo.runtime === 'rancher-desktop' ? 'Rancher Desktop' : 'Docker Desktop';
    onStatus?.({
      state: 'starting-runtime',
      runtime: runtimeInfo.runtime,
      message: `Starting ${runtimeName}...`,
      hint: `${runtimeName} is starting. This may take a few moments.`
    });

    try {
      await startDockerRuntime(runtimeInfo);
      onRuntimeStarted?.();
    } catch (error) {
      logger.error({ err: error }, `[DockerRuntime] Failed to start ${runtimeInfo.runtime}.`);
      onStatus?.({
        state: 'error',
        message: `Failed to start ${runtimeName}.`,
        hint: `Please ensure that ${runtimeName} is installed and can be started manually.`
      });
      throw error;
    }
    onStatus?.({
      state: 'waiting-for-engine',
      message: 'Waiting for Docker Engine...',
      hint: 'Docker Engine is starting. Your workspace will be ready shortly.'
    });

    try {
      return await this.waitForDocker();
    } catch (error) {
      logger.error({ err: error }, '[DockerRuntime] Docker Engine failed to become ready.');
      onStatus?.({
        state: 'error',
        message: 'Docker Engine did not become ready.',
        hint: `The ${runtimeName} may still be starting. Try again in a moment.`
      });
      throw error;
    }
  }

  private async detectRuntime(): Promise<DockerRuntimeInfo | null> {
    logger.debug('[DockerRuntime] Detecting Docker runtime.');

    const dockerPath = await getDockerCliPath();
    logger.debug(`[DockerRuntime] Docker CLI path: ${dockerPath ?? 'not found'}`);

    if (dockerPath) {
      const context = await this.getCurrentContext(dockerPath);

      logger.debug(`[DockerRuntime] Current Docker context: ${context ?? 'none'}`);

      if (context === 'rancher-desktop') {
        logger.info('[DockerRuntime] Rancher Desktop detected from Docker context.');

        const rdctlPath = await getRdctlPath();

        if (rdctlPath) {
          return {
            runtime: 'rancher-desktop',
            executablePath: rdctlPath
          };
        }

        logger.warn('[DockerRuntime] Rancher Desktop context detected, but rdctl was not found.');
      }
    } else {
      logger.debug('[DockerRuntime] Docker CLI was not found.');
    }

    return this.detectPlatformRuntime(dockerPath);
  }

  private async getCurrentContext(dockerPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(dockerPath, ['context', 'show'], {
        encoding: 'utf8',
        windowsHide: true
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async detectPlatformRuntime(dockerPath: string | null): Promise<DockerRuntimeInfo | null> {
    logger.debug('[DockerRuntime] Checking installed Docker runtimes.');

    if (dockerPath) {
      logger.info(`[DockerRuntime] Docker runtime detected. Docker CLI: ${dockerPath}`);

      return {
        runtime: 'docker-desktop',
        executablePath: dockerPath
      };
    }

    const rdctlPath = await getRdctlPath();

    if (rdctlPath) {
      logger.info(`[DockerRuntime] Rancher Desktop detected. rdctl: ${rdctlPath}`);

      return {
        runtime: 'rancher-desktop',
        executablePath: rdctlPath
      };
    }

    logger.warn('[DockerRuntime] No supported Docker runtime is installed.');

    return null;
  }

  private async waitForDocker(): Promise<Docker> {
    const timeout = 120_000;
    const interval = 1_000;
    const startedAt = Date.now();

    logger.info('[DockerRuntime] Waiting for Docker engine.');

    while (Date.now() - startedAt < timeout) {
      try {
        const client = await createDockerClient();

        await client.ping();

        logger.info('[DockerRuntime] Docker engine is ready.');

        return client;
      } catch (error) {
        logger.debug(
          `[DockerRuntime] Docker engine is not ready yet: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    }

    throw new DockerConnectionError(
      'Docker runtime started, but Docker Engine did not become ready within 120 seconds.'
    );
  }
}
