import Docker from 'dockerode';
import { createDockerClient } from './docker.client';
import { DockerConnectionError } from './docker.connection';
import {
  isDockerDesktopInstalled,
  isRancherDesktopInstalled,
  startDockerRuntime,
  type DockerRuntime
} from './docker.runtime';
import { logger } from '../logger';

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

    const runtime = await this.detectRuntime();
    if (!runtime) {
      throw new DockerConnectionError('Docker is not available and no supported container runtime was detected.');
    }
    logger.info(`[DockerRuntime] Starting detected runtime: ${runtime}`);
    await startDockerRuntime(runtime);

    return this.waitForDocker();
  }

  private async detectRuntime(): Promise<DockerRuntime | null> {
    logger.debug('[DockerRuntime] Detecting Docker runtime.');

    const context = await this.getCurrentContext();
    logger.debug(`[DockerRuntime] Current Docker context: ${context ?? 'none'}`);

    if (context === 'rancher-desktop') {
      logger.info('[DockerRuntime] Rancher Desktop detected from Docker context.');
      return 'rancher-desktop';
    }

    return this.detectPlatformRuntime();
  }

  private async getCurrentContext(): Promise<string | null> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');

      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('docker', ['context', 'show'], {
        encoding: 'utf8',
        windowsHide: true
      });

      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async detectPlatformRuntime(): Promise<DockerRuntime | null> {
    logger.debug('[DockerRuntime] Checking installed Docker runtimes.');

    if (await isDockerDesktopInstalled()) {
      logger.info('[DockerRuntime] Docker Desktop is installed.');
      return 'docker-desktop';
    }
    if (await isRancherDesktopInstalled()) {
      logger.info('[DockerRuntime] Rancher Desktop is installed.');
      return 'rancher-desktop';
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
