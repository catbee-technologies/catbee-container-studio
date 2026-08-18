import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop';

export async function startDockerRuntime(runtime: DockerRuntime): Promise<void> {
  logger.info(`[DockerRuntime] Starting runtime: ${runtime}`);

  switch (runtime) {
    case 'docker-desktop':
      await startDockerDesktop();
      return;

    case 'rancher-desktop':
      await startRancherDesktop();
      return;
  }
}

async function startDockerDesktop(): Promise<void> {
  logger.debug('[DockerRuntime] Starting Docker Desktop.');

  await execFileAsync('docker', ['desktop', 'start', '--detach'], {
    encoding: 'utf8',
    windowsHide: true
  });

  logger.info('[DockerRuntime] Docker Desktop start command completed.');
}

async function startRancherDesktop(): Promise<void> {
  logger.debug('[DockerRuntime] Starting Rancher Desktop.');

  await execFileAsync('rdctl', ['start'], {
    encoding: 'utf8',
    windowsHide: true
  });

  logger.info('[DockerRuntime] Rancher Desktop start command completed.');
}

export async function isRancherDesktopInstalled(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['rdctl'], {
      encoding: 'utf8',
      windowsHide: true
    });

    return true;
  } catch {
    return false;
  }
}

export async function isDockerDesktopInstalled(): Promise<boolean> {
  const paths = await getDockerDesktopPaths();

  for (const path of paths) {
    try {
      await access(path);
      logger.debug(`[DockerRuntime] Docker Desktop found at: ${path}`);
      return true;
    } catch {
      logger.debug(`[DockerRuntime] Docker Desktop not found at: ${path}`);
    }
  }

  return false;
}

async function getDockerDesktopPaths(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return getPlatformDefaultDockerDesktopPaths();
  }

  const registryPath = await getWindowsDockerDesktopInstallPath();

  return [...(registryPath ? [registryPath] : []), ...getWindowsDockerDesktopFallbackPaths()];
}

function getPlatformDefaultDockerDesktopPaths(): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['/Applications/Docker.app'];

    case 'linux':
      return ['/usr/bin/docker-desktop', '/usr/local/bin/docker-desktop'];

    default:
      return [];
  }
}

function getWindowsDockerDesktopFallbackPaths(): string[] {
  return [
    // eslint-disable-next-line n/no-process-env
    ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Programs\\DockerDesktop\\Docker Desktop.exe`] : []),
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe'
  ];
}

async function getWindowsDockerDesktopInstallPath(): Promise<string | null> {
  const registryKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop'
  ];

  for (const key of registryKeys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        windowsHide: true
      });

      const match = stdout.match(/InstallLocation\s+REG_\w+\s+(.+)/i);
      if (!match) {
        continue;
      }

      const installLocation = match[1].trim();
      if (installLocation) {
        logger.debug(`[DockerRuntime] Docker Desktop registry location: ${installLocation}`);
        return `${installLocation}\\Docker Desktop.exe`;
      }
    } catch {
      // Registry key does not exist. Continue with the next one.
    }
  }
  return null;
}
