import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import Docker from 'dockerode';
import { createDockerClient } from './docker.client';
import { DockerConnectionError } from './docker.connection';
import { DockerRuntimeInfo, getDockerCliPath, getRdctlPath, startDockerRuntime } from './docker.runtime';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export class DockerRuntimeManager {
  async ensureDockerAvailable(): Promise<Docker> {
    logger.debug('[DockerRuntime] Checking Docker availability.');

    try {
      const client = await createDockerClient();
      await client.ping();
      logger.info('[DockerRuntime] Docker is already available.');
      return client;
    } catch (error) {
      logger.debug(`[DockerRuntime] Docker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const runtimeInfo = await this.detectRuntime();
    if (!runtimeInfo) {
      throw new DockerConnectionError('Docker is not available and no supported container runtime was detected.');
    }
    logger.info(`[DockerRuntime] Starting detected runtime: ${runtimeInfo.runtime}`);
    await startDockerRuntime(runtimeInfo);

    return this.waitForDocker();
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
