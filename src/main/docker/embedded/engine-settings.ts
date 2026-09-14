import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../logger';

export interface DesktopProxyConfig {
  mode: 'system' | 'none' | 'manual';
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface ContainersProxyConfig {
  mode: 'same-as-host' | 'system' | 'none' | 'manual';
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface NetworkSettingsConfig {
  dockerSubnet: string;
  enableHostNetworking: boolean;
  portBindingBehavior: 'open' | 'localhost';
  defaultNetworkingMode: 'ipv4' | 'dualstack';
  dnsResolution: 'auto' | 'never' | 'always';
}

export interface EngineSettings {
  engineMode: 'auto' | 'embedded' | 'external';
  exposeTcp: boolean;
  resourceSaverEnabled: boolean;
  resourceSaverTimeout: number;
  wslIntegrationEnabled: boolean;
  wslAdditionalDistros: string[];
  fileSharingPaths: string[];
  desktopProxy: DesktopProxyConfig;
  containersProxy: ContainersProxyConfig;
  network: NetworkSettingsConfig;
  endpoint?: string;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  engineMode: 'auto',
  exposeTcp: true,
  resourceSaverEnabled: false,
  resourceSaverTimeout: 300,
  wslIntegrationEnabled: true,
  wslAdditionalDistros: [],
  fileSharingPaths: process.platform === 'win32' ? [] : process.platform === 'darwin' ? [] : [],
  desktopProxy: {
    mode: 'system',
    httpProxy: '',
    httpsProxy: '',
    noProxy: 'localhost,127.0.0.1,docker.internal'
  },
  containersProxy: {
    mode: 'same-as-host',
    httpProxy: '',
    httpsProxy: '',
    noProxy: 'localhost,127.0.0.1'
  },
  network: {
    dockerSubnet: '192.168.65.0/24',
    enableHostNetworking: false,
    portBindingBehavior: 'open',
    defaultNetworkingMode: 'ipv4',
    dnsResolution: 'auto'
  }
};

function getSettingsFilePath(): string {
  if (process.platform === 'win32') {
    // eslint-disable-next-line n/no-process-env
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'CatBee', 'engine', 'settings.json');
  }
  // eslint-disable-next-line n/no-process-env
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.config', 'catbee', 'engine-settings.json');
}

export async function getEngineSettings(): Promise<EngineSettings> {
  const filePath = getSettingsFilePath();
  try {
    await access(filePath);
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<EngineSettings>;
    return {
      ...DEFAULT_ENGINE_SETTINGS,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_ENGINE_SETTINGS };
  }
}

export async function saveEngineSettings(settings: Partial<EngineSettings>): Promise<EngineSettings> {
  const filePath = getSettingsFilePath();
  try {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });

    const current = await getEngineSettings();
    const updated: EngineSettings = {
      ...current,
      ...settings
    };

    await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
    logger.info({ settings: updated }, '[EngineSettings] Successfully saved engine settings.');
    return updated;
  } catch (error) {
    logger.error({ err: error }, '[EngineSettings] Failed to save engine settings.');
    throw error;
  }
}
