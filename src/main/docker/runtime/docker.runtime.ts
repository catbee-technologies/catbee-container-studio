import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { logger } from '../../logger';
import { DockerRuntimeInfo } from '../types/runtime.types';
import { getEngineBinDir } from '../embedded/engine-paths';

const execFileAsync = promisify(execFile);

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

  if (process.platform === 'win32') {
    const child = execFile(rdctlPath, ['start'], {
      encoding: 'utf8',
      windowsHide: true
    });

    child.on('error', error => {
      logger.error({ err: error }, '[DockerRuntime] Rancher Desktop start failed.');
    });

    child.on('exit', (code, signal) => {
      logger.debug(`[DockerRuntime] Rancher Desktop start process exited. code=${code}, signal=${signal ?? 'none'}`);
    });

    logger.info('[DockerRuntime] Rancher Desktop start command launched.');
    return;
  }

  await execFileAsync(rdctlPath, ['start'], {
    encoding: 'utf8',
    windowsHide: true
  });

  logger.info('[DockerRuntime] Rancher Desktop start command completed.');
}

let cachedDockerCliPath: string | null = null;
export async function getDockerCliPath(): Promise<string | null> {
  if (cachedDockerCliPath) {
    return cachedDockerCliPath;
  }

  // 1. Check CatBee's own embedded host Docker CLI first
  const embeddedCli = path.join(getEngineBinDir(), process.platform === 'win32' ? 'docker.exe' : 'docker');
  try {
    await access(embeddedCli);
    logger.debug(`[DockerRuntime] Using CatBee built-in Docker CLI at: ${embeddedCli}`);
    cachedDockerCliPath = embeddedCli;
    return embeddedCli;
  } catch {
    // Continue with candidate lookups
  }

  const candidates: string[] = [];

  // eslint-disable-next-line n/no-process-env
  const home = process.env.HOME;

  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/opt/homebrew/bin/docker',
        '/usr/local/bin/docker',
        path.join(home ?? '', '.docker', 'bin', 'docker'),
        path.join(home ?? '', '.rd', 'bin', 'docker')
      );
      break;

    case 'linux':
      candidates.push('/usr/local/bin/docker', '/usr/bin/docker');
      break;

    case 'win32': {
      try {
        const { stdout } = await execFileAsync('where', ['docker'], {
          encoding: 'utf8',
          windowsHide: true
        });
        const paths = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);
        // Prefer official Docker Desktop CLI over third-party distributions (like Rancher Desktop)
        const dockerPath =
          paths.find(p => p.toLowerCase().includes('dockerdesktop') || p.toLowerCase().includes('docker\\docker')) ??
          paths[0];
        if (dockerPath) {
          logger.debug(`[DockerRuntime] Docker CLI found at: ${dockerPath}`);
          cachedDockerCliPath = dockerPath;
          return dockerPath;
        }
      } catch {
        // Continue with fallback paths.
      }
      // eslint-disable-next-line n/no-process-env
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      // eslint-disable-next-line n/no-process-env
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
      candidates.push(
        path.join(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
        path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
      );
      break;
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      logger.debug(`[DockerRuntime] Docker CLI found at: ${candidate}`);
      cachedDockerCliPath = candidate;
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
        cachedDockerCliPath = dockerPath;
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
      candidates.push(
        path.join(
          // eslint-disable-next-line n/no-process-env
          process.env.PROGRAMFILES ?? 'C:\\Program Files',
          'Rancher Desktop',
          'resources',
          'resources',
          'win32',
          'bin',
          'rdctl.exe'
        )
      );

      try {
        const { stdout } = await execFileAsync('where', ['rdctl'], {
          encoding: 'utf8',
          windowsHide: true
        });

        const rdctlPath = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(line => line.toLowerCase().endsWith('rdctl.exe'));

        if (rdctlPath) {
          logger.debug(`[DockerRuntime] Rancher Desktop rdctl found in PATH: ${rdctlPath}`);
          return rdctlPath;
        }
      } catch {
        // Continue with known installation paths.
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
