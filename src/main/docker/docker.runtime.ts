import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop';

export interface DockerRuntimeInfo {
  runtime: DockerRuntime;
  executablePath: string;
}

export type DockerInitializationStatus =
  | {
      state: 'checking';
      message: string;
      hint: string;
    }
  | {
      state: 'detecting-runtime';
      message: string;
      hint: string;
    }
  | {
      state: 'starting-runtime';
      runtime: DockerRuntime;
      message: string;
      hint: string;
    }
  | {
      state: 'waiting-for-engine';
      message: string;
      hint: string;
    }
  | {
      state: 'ready';
      message: string;
      hint: string;
    }
  | {
      state: 'error';
      message: string;
      hint: string;
    };

export async function startDockerRuntime(runtimeInfo: DockerRuntimeInfo): Promise<void> {
  logger.info(`[DockerRuntime] Starting runtime: ${runtimeInfo.runtime}`);

  switch (runtimeInfo.runtime) {
    case 'docker-desktop':
      await startDockerDesktop(runtimeInfo.executablePath);
      return;

    case 'rancher-desktop':
      await startRancherDesktop(runtimeInfo.executablePath);
      return;
  }
}

async function startDockerDesktop(dockerPath: string): Promise<void> {
  logger.debug(`[DockerRuntime] Starting Docker Desktop using: ${dockerPath}`);

  await execFileAsync(dockerPath, ['desktop', 'start', '--detach'], {
    encoding: 'utf8',
    windowsHide: true
  });

  logger.info('[DockerRuntime] Docker Desktop start command completed.');
}

async function startRancherDesktop(rdctlPath: string): Promise<void> {
  logger.debug(`[DockerRuntime] Starting Rancher Desktop using: ${rdctlPath}`);

  await execFileAsync(rdctlPath, ['start'], {
    encoding: 'utf8',
    windowsHide: true
  });

  logger.info('[DockerRuntime] Rancher Desktop start command completed.');
}

export async function getDockerCliPath(): Promise<string | null> {
  const candidates: string[] = [];

  // eslint-disable-next-line n/no-process-env
  const home = process.env.HOME;

  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/opt/homebrew/bin/docker',
        '/usr/local/bin/docker',
        path.join(home ?? '', '.docker', 'bin', 'docker')
      );
      break;

    case 'linux':
      candidates.push('/usr/local/bin/docker', '/usr/bin/docker');
      break;

    case 'win32':
      try {
        const { stdout } = await execFileAsync('where', ['docker'], {
          encoding: 'utf8',
          windowsHide: true
        });
        const dockerPath = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(Boolean);
        if (dockerPath) {
          return dockerPath;
        }
      } catch {
        // Continue with fallback paths.
      }
      break;
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      logger.debug(`[DockerRuntime] Docker CLI found at: ${candidate}`);
      return candidate;
    } catch {
      logger.debug(`[DockerRuntime] Docker CLI not found at: ${candidate}`);
    }
  }

  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('which', ['docker'], {
        encoding: 'utf8',
        windowsHide: true
      });

      const dockerPath = stdout.trim();

      if (dockerPath) {
        logger.debug(`[DockerRuntime] Docker CLI found in PATH: ${dockerPath}`);
        return dockerPath;
      }
    } catch {
      // Docker CLI is not available in PATH.
    }
  }

  return null;
}

export async function getRdctlPath(): Promise<string | null> {
  const candidates: string[] = [];

  // eslint-disable-next-line n/no-process-env
  const home = process.env.HOME;

  switch (process.platform) {
    case 'darwin':
      candidates.push(path.join(home ?? '', '.rd', 'bin', 'rdctl'), '/opt/homebrew/bin/rdctl', '/usr/local/bin/rdctl');
      break;

    case 'linux':
      candidates.push(path.join(home ?? '', '.rd', 'bin', 'rdctl'), '/usr/local/bin/rdctl', '/usr/bin/rdctl');
      break;

    case 'win32':
      try {
        const { stdout } = await execFileAsync('where', ['rdctl'], {
          encoding: 'utf8',
          windowsHide: true
        });

        const rdctlPath = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(Boolean);

        if (rdctlPath) {
          return rdctlPath;
        }
      } catch {
        // Continue with fallback paths.
      }
      break;
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      logger.debug(`[DockerRuntime] Rancher Desktop rdctl found at: ${candidate}`);
      return candidate;
    } catch {
      logger.debug(`[DockerRuntime] rdctl not found at: ${candidate}`);
    }
  }

  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('which', ['rdctl'], {
        encoding: 'utf8',
        windowsHide: true
      });

      const rdctlPath = stdout.trim();

      if (rdctlPath) {
        logger.debug(`[DockerRuntime] Rancher Desktop rdctl found in PATH: ${rdctlPath}`);
        return rdctlPath;
      }
    } catch {
      // rdctl is not available in PATH.
    }
  }
  return null;
}
