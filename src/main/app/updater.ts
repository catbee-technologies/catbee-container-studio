import { spawn } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { autoUpdater, type BaseUpdater } from 'electron-updater';
import { isDev, isMacOS } from './constants';
import { logger as appLogger } from '../logger';
import { IPC_CHANNELS } from '../../ipc/channels';

const logger = appLogger.child({}, { msgPrefix: '[AutoUpdater] ' });
const electronUpdaterLogger = appLogger.child({}, { msgPrefix: '[ElectronUpdater] ' });

type UpdateInstallPhase = 'preparing' | 'installing';
type UpdateInstallStatus = { phase: UpdateInstallPhase } | { phase: 'failed'; message: string };

export type AutoUpdaterStatus =
  | {
      status: 'checking';
    }
  | {
      status: 'available';
      version: string;
    }
  | {
      status: 'not-available';
      version: string;
    }
  | {
      status: 'downloading';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | {
      status: 'downloaded';
      version: string;
      install?: UpdateInstallStatus;
    }
  | {
      status: 'error';
      message: string;
    };

let mainWindow: BrowserWindow | null = null;
let downloadedUpdate: { file: string; version: string } | null = null;
let installPhase: UpdateInstallPhase | null = null;
let recoverFromInstallFailure: (() => void) | null = null;

export type PrepareForUpdateInstall = () => Promise<() => void>;

export interface ReleaseNotesInfo {
  version: string;
  releaseName: string;
  notes: string;
  publishedAt: string;
  htmlUrl: string;
}

const releaseNotesCache = new Map<string, ReleaseNotesInfo>();

export async function getReleaseNotes(version?: string): Promise<ReleaseNotesInfo | null> {
  const currentAppVersion = app.getVersion();
  const isPrereleaseChannel = currentAppVersion.includes('-');

  let targetTag: string | null = null;
  if (version && version !== 'latest') {
    targetTag = version.startsWith('v') ? version : `v${version}`;
  } else if (!version) {
    targetTag = `v${currentAppVersion}`;
  }
  const cacheKey = targetTag ?? (isPrereleaseChannel ? 'latest-prerelease' : 'latest');

  if (releaseNotesCache.has(cacheKey)) {
    return releaseNotesCache.get(cacheKey)!;
  }

  // GitHub's /releases/latest returns ONLY stable releases, ignoring all pre-releases.
  // For pre-release channels when requesting latest, fetch /releases to get the true latest (including pre-releases).
  const url = targetTag
    ? `https://api.github.com/repos/catbee-technologies/catbee-container-studio/releases/tags/${encodeURIComponent(targetTag)}`
    : isPrereleaseChannel
      ? `https://api.github.com/repos/catbee-technologies/catbee-container-studio/releases?per_page=5`
      : `https://api.github.com/repos/catbee-technologies/catbee-container-studio/releases/latest`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CatBee-Container-Studio-App',
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (!res.ok) {
      logger.warn(`Release not found on GitHub for ${cacheKey} (HTTP ${res.status})`);
      return null;
    }

    const rawData = await res.json();
    const data = (Array.isArray(rawData) ? rawData[0] : rawData) as {
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      html_url?: string;
    };

    if (!data?.tag_name) {
      return null;
    }

    const info: ReleaseNotesInfo = {
      version: data.tag_name?.replace(/^v/, '') ?? version ?? currentAppVersion,
      releaseName: data.name ?? data.tag_name ?? '',
      notes: data.body ?? 'No release notes provided for this version.',
      publishedAt: data.published_at ?? '',
      htmlUrl: data.html_url ?? `https://github.com/catbee-technologies/catbee-container-studio/releases`
    };

    releaseNotesCache.set(cacheKey, info);
    return info;
  } catch (error) {
    logger.warn({ err: error }, `Failed to fetch release notes for ${cacheKey}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const MS_STORE_PRODUCT_ID = '9NX6H3J2RNX2';
const MS_STORE_CATALOG_URL = `https://displaycatalog.mp.microsoft.com/v7.0/products/${MS_STORE_PRODUCT_ID}?market=US&languages=en-us`;

function compareVersions(v1: string, v2: string): number {
  const clean = (v: string) => v.replace(/^v/i, '').split('-')[0];
  const parts1 = clean(v1)
    .split('.')
    .map(n => Number.parseInt(n, 10) || 0);
  const parts2 = clean(v2)
    .split('.')
    .map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

async function checkMicrosoftStoreVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(MS_STORE_CATALOG_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Display Catalog responded with HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      Product?: {
        DisplaySkuAvailabilities?: Array<{
          Sku?: {
            Properties?: {
              Packages?: Array<{
                PackageFullName?: string;
                Version?: string;
              }>;
            };
          };
        }>;
      };
    };

    let latestVersion: string | null = null;
    const availabilities = data.Product?.DisplaySkuAvailabilities ?? [];
    for (const sku of availabilities) {
      const packages = sku.Sku?.Properties?.Packages ?? [];
      for (const pkg of packages) {
        let ver: string | null = null;
        if (pkg.PackageFullName) {
          const match = /_(\d+(?:\.\d+)+)_/.exec(pkg.PackageFullName);
          if (match) {
            ver = match[1];
          }
        }
        if (!ver && pkg.Version) {
          try {
            const v = BigInt(pkg.Version);
            const major = (v >> 48n) & 0xffffn;
            const minor = (v >> 32n) & 0xffffn;
            const build = (v >> 16n) & 0xffffn;
            const rev = v & 0xffffn;
            ver = `${major}.${minor}.${build}.${rev}`;
          } catch {
            // ignore
          }
        }

        if (ver) {
          const normalized = ver.replace(/\.0$/, '');
          if (!latestVersion || compareVersions(normalized, latestVersion) > 0) {
            latestVersion = normalized;
          }
        }
      }
    }
    return latestVersion;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function initializeAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;

  autoUpdater.logger = {
    debug: message => electronUpdaterLogger.debug('%s', message),
    info: message => electronUpdaterLogger.debug('%s', message),
    warn: message => electronUpdaterLogger.warn('%s', message),
    error: message => electronUpdaterLogger.error('%s', message)
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallEvent = 'onQuit';
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  autoUpdater.on('checking-for-update', () => {
    logger.debug('Checking for update...');
    sendStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', info => {
    logger.debug(`Update available: ${info.version}`);
    sendStatus({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', info => {
    logger.debug(`No update available: ${info.version}`);
    sendStatus({ status: 'not-available', version: info.version });
  });

  autoUpdater.on('download-progress', progress => {
    logger.debug(`Download progress: ${progress.percent.toFixed(1)}%`);

    sendStatus({
      status: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', info => {
    downloadedUpdate = { file: info.downloadedFile, version: info.version };
    logger.info(`Update downloaded: ${info.version}`);
    sendStatus({ status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', error => {
    logger.error({ err: error }, 'Error');
    if (recoverFromInstallFailure) {
      recoverFromInstallFailure();
      sendInstallStatus({ phase: 'failed', message: 'Could not install the update.' });
      return;
    }
    sendStatus({ status: 'error', message: getErrorMessage(error) });
  });
}

export function isMicrosoftStoreInstallation(): boolean {
  if (process.platform !== 'win32' || isDev) {
    return false;
  }
  return process.windowsStore || process.execPath.toLowerCase().includes('\\windowsapps\\');
}

export async function checkForUpdates(): Promise<void> {
  if (installPhase) {
    sendInstallStatus({ phase: installPhase });
    return;
  }
  if (isDev) {
    logger.debug('Skipping update check in development.');
    return;
  }

  if (isMicrosoftStoreInstallation()) {
    logger.debug('Checking Microsoft Store Display Catalog for updates...');
    sendStatus({ status: 'checking' });
    try {
      const storeVersion = await checkMicrosoftStoreVersion();
      const currentVersion = app.getVersion();
      if (storeVersion && compareVersions(storeVersion, currentVersion) > 0) {
        logger.debug(`Microsoft Store update available: ${storeVersion}`);
        sendStatus({ status: 'available', version: storeVersion });
      } else {
        logger.debug(`Microsoft Store app is up to date (${currentVersion})`);
        sendStatus({ status: 'not-available', version: currentVersion });
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to check Microsoft Store updates');
      sendStatus({
        status: 'error',
        message: 'Unable to check for Microsoft Store updates. Please check your internet connection.'
      });
    }
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result === null && process.platform === 'linux') {
      sendStatus({
        status: 'error',
        message: 'Update checks are unavailable for this package. Download a new archive from GitHub Releases.'
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to check for updates');
    sendStatus({
      status: 'error',
      message: getErrorMessage(error)
    });
  }
}

export async function downloadUpdate(): Promise<void> {
  if (isDev || isMicrosoftStoreInstallation() || installPhase) {
    return;
  }

  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    logger.error({ err: error }, 'Failed to download update');
    sendStatus({ status: 'error', message: getErrorMessage(error) });
  }
}

export function skipAutoInstallOnQuit(): void {
  autoUpdater.autoInstallEvent = 'manual';
}

export async function restartAndInstallUpdate(prepare: PrepareForUpdateInstall): Promise<void> {
  if (isDev || isMacOS || isMicrosoftStoreInstallation() || !downloadedUpdate?.file || installPhase) {
    return;
  }
  const isLinuxPackage = process.platform === 'linux' && /\.(deb|rpm)$/.test(downloadedUpdate.file);
  installPhase = 'preparing';
  sendInstallStatus({ phase: installPhase });

  let restoreShutdownState: () => void;
  try {
    restoreShutdownState = await prepare();
  } catch (err) {
    installPhase = null;
    logger.error({ err }, 'Background shutdown did not finish before update installation.');
    sendInstallStatus({ phase: 'failed', message: 'CatBee could not finish shutting down.' });
    return;
  }

  recoverFromInstallFailure = () => {
    restoreShutdownState();
    recoverFromInstallFailure = null;
    installPhase = null;
  };
  installPhase = 'installing';
  sendInstallStatus({ phase: installPhase });
  logger.info('Restarting and installing update...');
  try {
    if (isLinuxPackage) {
      const installed = await (autoUpdater as BaseUpdater).installAsync(false, false);
      if (!installed) {
        if (recoverFromInstallFailure) {
          recoverFromInstallFailure();
          sendInstallStatus({ phase: 'failed', message: 'Could not install the update.' });
        }
        return;
      }
      app.once('quit', relaunchLinuxPackage);
      app.quit();
      return;
    }
    autoUpdater.quitAndInstall();
  } catch (err) {
    recoverFromInstallFailure?.();
    logger.error({ err }, 'Could not start the update installer.');
    sendInstallStatus({ phase: 'failed', message: 'Could not start the update installer.' });
  }
}

function relaunchLinuxPackage(): void {
  // Electron's Linux relauncher sets NoNewPrivs, which blocks RootlessKit's newuidmap helper.
  // The quit event fires before Electron releases its single-instance lock.
  app.releaseSingleInstanceLock();
  const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' });
  child.once('error', err => logger.error({ err }, 'Could not reopen CatBee after installing the update.'));
  child.unref();
}

function sendInstallStatus(install: UpdateInstallStatus): void {
  if (downloadedUpdate) {
    sendStatus({ status: 'downloaded', version: downloadedUpdate.version, install });
  }
}

function sendStatus(status: AutoUpdaterStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.App.Updater.Status, status);
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'An unexpected error occurred while checking for updates.';
  }

  if (
    error.message.includes('ERR_UPDATER_INVALID_RELEASE_FEED') ||
    error.message.includes('Unable to find latest version on GitHub')
  ) {
    return 'No compatible release is currently available.';
  }

  if (
    error.message.includes('ENOTFOUND') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ETIMEDOUT')
  ) {
    return 'Unable to connect to GitHub. Please check your internet connection and try again.';
  }

  return 'An unexpected error occurred while checking for updates.';
}
