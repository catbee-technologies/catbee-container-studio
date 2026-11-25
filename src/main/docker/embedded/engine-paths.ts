import os from 'node:os';
import path from 'node:path';

/* eslint-disable n/no-process-env */

export function homeDir(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE ?? os.homedir();
  }
  return process.env.SNAP_REAL_HOME ?? process.env.HOME ?? os.homedir();
}

/** Root directory holding all CatBee built-in engine artifacts for the current OS. */
export function getEngineRootDir(): string {
  switch (process.platform) {
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'CatBee', 'engine');
    }
    case 'darwin':
      return path.join(homeDir(), 'Library', 'Application Support', 'CatBee', 'engine');
    default: {
      const dataHome = process.env.XDG_DATA_HOME ?? path.join(homeDir(), '.local', 'share');
      return path.join(dataHome, 'catbee', 'engine');
    }
  }
}

/** Location of the persisted engine settings file (kept stable for backward compatibility). */
export function getEngineSettingsFilePath(): string {
  if (process.platform === 'win32') {
    return path.join(getEngineRootDir(), 'settings.json');
  }
  return path.join(homeDir(), '.config', 'catbee', 'engine-settings.json');
}

export function getEngineManifestPath(): string {
  return path.join(getEngineRootDir(), 'manifest.json');
}

export function getWslEngineDiskPath(): string {
  return path.join(getEngineRootDir(), 'wsl', 'ext4.vhdx');
}

export function getEngineBinDir(): string {
  return path.join(homeDir(), '.catbee', 'bin');
}

export function getEngineDownloadsDir(): string {
  return path.join(getEngineRootDir(), 'downloads');
}

export function getEngineLogsDir(): string {
  return path.join(getEngineRootDir(), 'logs');
}

/**
 * Lima keeps unix sockets inside its home directory, and macOS limits socket paths to 104 bytes,
 * so LIMA_HOME must stay short (the Application Support path is too long for some user names).
 */
export function getLimaHomeDir(): string {
  return path.join(homeDir(), '.catbee', 'lima');
}

/** Runtime directory used by the Linux rootless daemon (XDG_RUNTIME_DIR for rootlesskit). */
export function getLinuxRuntimeDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    return path.join(runtimeDir, 'catbee');
  }
  return path.join(homeDir(), '.catbee', 'run');
}

/**
 * Common Unix and shell startup profile filenames searched when configuring $PATH
 * across macOS, Linux, and Windows (Git Bash / MSYS).
 */
export const SHELL_PROFILE_TARGETS: readonly string[] = [
  '.bashrc',
  '.profile',
  '.bash_profile',
  '.zshrc',
  '.zprofile'
] as const;

export {
  CATBEE_WINDOWS_PIPE_NAME,
  CATBEE_WINDOWS_PIPE_PATH,
  CATBEE_LIMA_INSTANCE,
  CATBEE_WSL_DISTRO,
  CATBEE_EXPOSED_TCP_PORT,
  CATBEE_WSL_DOCKER_TCP_PORT
} from '../../../constants.docker';
