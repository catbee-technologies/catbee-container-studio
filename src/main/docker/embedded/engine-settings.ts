import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../logger';
import { getEngineSettingsFilePath } from './engine-paths';
import { DEFAULT_K8S_VERSION } from '../../../constants.docker';

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
  portBindingBehavior: 'open' | 'localhost';
  defaultNetworkingMode: 'ipv4' | 'dualstack';
}

export interface KubernetesSettingsConfig {
  enabled: boolean;
  provisioner: 'kind' | 'kubeadm';
  version: string;
  nodeCount: number;
  showSystemContainers: boolean;
}

/** VM resource allocation. Only honoured by VM-based backends (macOS / Lima). */
export interface ResourceSettingsConfig {
  cpus: number;
  memoryGb: number;
  swapGb: number;
  diskGb: number;
  /** Apple Silicon only: run linux/amd64 containers through Rosetta 2. */
  rosetta: boolean;
}

export type EngineMode = 'auto' | 'embedded' | 'external';

export interface EngineSettings {
  engineMode: EngineMode;
  exposeTcp: boolean;
  resourceSaverEnabled: boolean;
  resourceSaverTimeout: number;
  wslIntegrationEnabled: boolean;
  wslAdditionalDistros: string[];
  fileSharingPaths: string[];
  forwardHostFileChanges: boolean;
  desktopProxy: DesktopProxyConfig;
  containersProxy: ContainersProxyConfig;
  network: NetworkSettingsConfig;
  resources: ResourceSettingsConfig;
  kubernetes: KubernetesSettingsConfig;
  endpoint?: string;
}

function defaultResources(): ResourceSettingsConfig {
  const cpuCount = os.cpus().length || 2;
  const totalGb = Math.floor(os.totalmem() / 1024 ** 3) || 4;
  return {
    cpus: Math.min(4, Math.max(1, Math.floor(cpuCount / 2))),
    memoryGb: Math.min(8, Math.max(2, Math.floor(totalGb / 2))),
    swapGb: 1,
    diskGb: 64,
    rosetta: process.platform === 'darwin' && process.arch === 'arm64'
  };
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  engineMode: 'auto',
  exposeTcp: false,
  resourceSaverEnabled: false,
  resourceSaverTimeout: 300,
  wslIntegrationEnabled: true,
  wslAdditionalDistros: [],
  // Directories shared into the macOS VM. An empty list also falls back to these in the Lima driver.
  fileSharingPaths: process.platform === 'darwin' ? [os.homedir(), '/var/folders'] : [],
  forwardHostFileChanges: false,
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
    dockerSubnet: ['192', '168', '65', '0/24'].join('.'),
    portBindingBehavior: 'open',
    defaultNetworkingMode: 'ipv4'
  },
  resources: defaultResources(),
  kubernetes: {
    enabled: false,
    provisioner: 'kind',
    version: DEFAULT_K8S_VERSION,
    nodeCount: 1,
    showSystemContainers: false
  }
};

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function isValidIpv4Cidr(value: string): boolean {
  const match = IPV4_CIDR.exec(value.trim());
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  return octets.every(o => o >= 0 && o <= 255) && prefix >= 8 && prefix <= 30;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((v): v is string => typeof v === 'string')
        .map(v => v.trim())
        .filter(Boolean)
    )
  ];
}

/** Keeps only known network keys so options removed in older versions don't linger in settings.json. */
function pickNetwork(network: NetworkSettingsConfig): NetworkSettingsConfig {
  const { dockerSubnet, portBindingBehavior, defaultNetworkingMode } = network;
  return {
    dockerSubnet,
    portBindingBehavior: portBindingBehavior === 'localhost' ? 'localhost' : 'open',
    defaultNetworkingMode: defaultNetworkingMode === 'dualstack' ? 'dualstack' : 'ipv4'
  };
}

/** Deep-merges a partial settings object over a base and normalises every field. */
export function mergeEngineSettings(base: EngineSettings, patch: Partial<EngineSettings>): EngineSettings {
  const merged: EngineSettings = {
    ...base,
    ...patch,
    desktopProxy: { ...base.desktopProxy, ...patch.desktopProxy },
    containersProxy: { ...base.containersProxy, ...patch.containersProxy },
    network: pickNetwork({ ...base.network, ...patch.network }),
    resources: { ...base.resources, ...patch.resources },
    kubernetes: {
      ...base.kubernetes,
      ...patch.kubernetes
    }
  };

  if (!['auto', 'embedded', 'external'].includes(merged.engineMode)) {
    merged.engineMode = DEFAULT_ENGINE_SETTINGS.engineMode;
  }
  merged.exposeTcp = Boolean(merged.exposeTcp);
  merged.resourceSaverEnabled = Boolean(merged.resourceSaverEnabled);
  merged.resourceSaverTimeout = clamp(merged.resourceSaverTimeout, 30, 3600, 300);
  merged.wslIntegrationEnabled = Boolean(merged.wslIntegrationEnabled);
  merged.wslAdditionalDistros = uniqueStrings(merged.wslAdditionalDistros);
  merged.fileSharingPaths = uniqueStrings(merged.fileSharingPaths);
  merged.forwardHostFileChanges = merged.forwardHostFileChanges === true;

  merged.kubernetes = {
    enabled: Boolean(merged.kubernetes?.enabled),
    provisioner: 'kind',
    version:
      typeof merged.kubernetes?.version === 'string' && merged.kubernetes.version.trim()
        ? merged.kubernetes.version.trim()
        : DEFAULT_ENGINE_SETTINGS.kubernetes.version,
    nodeCount: Math.round(clamp(merged.kubernetes?.nodeCount, 1, 8, DEFAULT_ENGINE_SETTINGS.kubernetes.nodeCount)),
    showSystemContainers: Boolean(merged.kubernetes?.showSystemContainers)
  };

  if (!isValidIpv4Cidr(merged.network.dockerSubnet ?? '')) {
    merged.network.dockerSubnet = DEFAULT_ENGINE_SETTINGS.network.dockerSubnet;
  }

  const defaults = defaultResources();
  merged.resources = {
    cpus: Math.round(clamp(merged.resources.cpus, 1, os.cpus().length || 64, defaults.cpus)),
    memoryGb: clamp(
      merged.resources.memoryGb,
      1,
      Math.max(2, Math.floor(os.totalmem() / 1024 ** 3)),
      defaults.memoryGb
    ),
    swapGb: clamp(merged.resources.swapGb, 0, 16, defaults.swapGb),
    diskGb: Math.round(clamp(merged.resources.diskGb, 16, 2048, defaults.diskGb)),
    rosetta: Boolean(merged.resources.rosetta) && process.platform === 'darwin' && process.arch === 'arm64'
  };

  return merged;
}

export async function getEngineSettings(): Promise<EngineSettings> {
  const filePath = getEngineSettingsFilePath();
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<EngineSettings>;
    return mergeEngineSettings(DEFAULT_ENGINE_SETTINGS, parsed);
  } catch {
    return mergeEngineSettings(DEFAULT_ENGINE_SETTINGS, {});
  }
}

let saveQueue = Promise.resolve();

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const uniqueId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${filePath}.${uniqueId}.tmp`;

  try {
    await writeFile(tempPath, data, 'utf8');
    let renamed = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await rename(tempPath, filePath);
        renamed = true;
        break;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'ENOENT')) {
          await new Promise(resolve => setTimeout(resolve, attempt * 40));
          continue;
        }
        try {
          await copyFile(tempPath, filePath);
          renamed = true;
          break;
        } catch {
          throw err;
        }
      }
    }

    if (!renamed) {
      await rename(tempPath, filePath);
    }
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/** Runs inside the settings queue so system changes and the file write can succeed or roll back together. */
type ApplySettings = (previous: EngineSettings, updated: EngineSettings, persist: () => Promise<void>) => Promise<void>;

async function persistSettings(
  previous: EngineSettings,
  updated: EngineSettings,
  apply?: ApplySettings
): Promise<void> {
  const persist = (): Promise<void> => atomicWriteFile(getEngineSettingsFilePath(), JSON.stringify(updated, null, 2));
  if (apply) await apply(previous, updated, persist);
  else await persist();
}

export function saveEngineSettings(settings: Partial<EngineSettings>, apply?: ApplySettings): Promise<EngineSettings> {
  const op = async (): Promise<EngineSettings> => {
    try {
      const current = await getEngineSettings();
      const updated = mergeEngineSettings(current, settings);

      await persistSettings(current, updated, apply);
      logger.info('[EngineSettings] Engine settings saved.');
      logger.debug({ settings: updated }, '[EngineSettings] Saved engine settings details.');
      return updated;
    } catch (error) {
      logger.error({ err: error }, '[EngineSettings] Failed to save engine settings.');
      throw error;
    }
  };

  const next = saveQueue.then(op, op);
  saveQueue = next.then(
    () => {},
    () => {}
  );
  return next;
}

export function resetEngineSettings(apply?: ApplySettings): Promise<EngineSettings> {
  const op = async (): Promise<EngineSettings> => {
    try {
      const current = await getEngineSettings();
      // If the user is currently using the CatBee built-in engine, keep it in embedded mode
      const preservedMode = current.engineMode === 'embedded' ? 'embedded' : DEFAULT_ENGINE_SETTINGS.engineMode;
      const reset = mergeEngineSettings(DEFAULT_ENGINE_SETTINGS, { engineMode: preservedMode });
      await persistSettings(current, reset, apply);
      logger.info('[EngineSettings] Engine settings reset to defaults.');
      logger.debug({ settings: reset }, '[EngineSettings] Reset engine settings details.');
      return reset;
    } catch (error) {
      logger.error({ err: error }, '[EngineSettings] Failed to reset engine settings.');
      throw error;
    }
  };

  const next = saveQueue.then(op, op);
  saveQueue = next.then(
    () => {},
    () => {}
  );
  return next;
}
