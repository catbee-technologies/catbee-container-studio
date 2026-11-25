import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { logger } from '../../logger';
import { DockerRuntimeInfo } from '../types/runtime.types';
import { getEngineBinDir, homeDir } from '../embedded/engine-paths';

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

async function findWindowsDockerCli(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where', ['docker'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const paths = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    // Prefer CatBee bundled or official Docker Desktop CLI over third-party distributions
    return (
      paths.find(
        p =>
          p.toLowerCase().includes(String.raw`.catbee\bin`) ||
          p.toLowerCase().includes('dockerdesktop') ||
          p.toLowerCase().includes(String.raw`docker\docker`)
      ) ??
      paths[0] ??
      null
    );
  } catch {
    return null;
  }
}

let cachedDockerCliPath: string | null = null;
let cachedDockerCliVersion: string | null = null;

export async function getDockerCliVersion(): Promise<string> {
  if (cachedDockerCliVersion) {
    return cachedDockerCliVersion;
  }
  try {
    const cliPath = await getDockerCliPath();
    if (cliPath) {
      const { stdout } = await execFileAsync(cliPath, ['--version'], { windowsHide: true });
      const match = /Docker version (\d+\.\d+(?:\.\d+)?)/i.exec(stdout);
      if (match?.[1]) {
        cachedDockerCliVersion = match[1];
        return cachedDockerCliVersion;
      }
    }
  } catch {
    // fallback
  }
  const { DOCKER_CLI_RELEASE_VERSION } = await import('../../../constants.docker.js');
  return DOCKER_CLI_RELEASE_VERSION;
}

export async function getDockerCliPath(): Promise<string | null> {
  if (cachedDockerCliPath) {
    try {
      await access(cachedDockerCliPath);
      return cachedDockerCliPath;
    } catch {
      cachedDockerCliPath = null;
      cachedDockerCliVersion = null;
    }
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
  const home = homeDir();

  switch (process.platform) {
    case 'darwin':
      candidates.push(
        path.join(home, '.catbee', 'bin', 'docker'),
        path.join(home, '.local', 'bin', 'docker'),
        '/opt/homebrew/bin/docker',
        '/usr/local/bin/docker',
        path.join(home, '.docker', 'bin', 'docker'),
        path.join(home, '.rd', 'bin', 'docker')
      );
      break;

    case 'linux':
      candidates.push(
        path.join(home, '.catbee', 'bin', 'docker'),
        path.join(home, '.local', 'bin', 'docker'),
        '/usr/local/bin/docker',
        '/usr/bin/docker',
        path.join(home, '.docker', 'bin', 'docker')
      );
      break;

    case 'win32': {
      const dockerPath = await findWindowsDockerCli();
      if (dockerPath) {
        logger.debug(`[DockerRuntime] Docker CLI found at: ${dockerPath}`);
        cachedDockerCliPath = dockerPath;
        return dockerPath;
      }
      // eslint-disable-next-line n/no-process-env
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      // eslint-disable-next-line n/no-process-env
      const programFiles = process.env.ProgramFiles ?? String.raw`C:\Program Files`;
      candidates.push(
        path.join(home, '.catbee', 'bin', 'docker.exe'),
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

  if (process.platform === 'win32') return null;

  const dockerPath = await findDockerCliInPath();
  if (dockerPath) {
    logger.debug(`[DockerRuntime] Docker CLI found in PATH: ${dockerPath}`);
    cachedDockerCliPath = dockerPath;
  }
  return dockerPath;
}

async function findDockerCliInPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['docker'], { encoding: 'utf8', windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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
