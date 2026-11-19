import type Docker from 'dockerode';
import {
  DockerActionResult,
  DockerContainerInfo,
  DockerContainerInspectInfo,
  DockerContainerStats,
  DockerFileEntry,
  DockerExecSessionCreateResult,
  DockerImageHistoryInfo,
  DockerImageInfo,
  DockerImageInspectInfo,
  DockerNetworkInfo,
  DockerVolumeInfo,
  DockerVolumeUsage,
  IpcResult,
  RecreateContainerOptions,
  StreamStartResult
} from './docker-api.types';

type IpcPromise<T> = Promise<IpcResult<T>>;

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop' | 'catbee-embedded' | 'system';

export type EngineStatusOperation = 'restart' | 'stop' | 'apply-settings';

export type DockerInitializationStatus = (
  | {
      state: 'loading';
      message: string;
      hint: string;
    }
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
      state: 'engine-not-installed';
      message: string;
      hint: string;
      prerequisitesOk: boolean;
      reason?: string;
      actionHint?: string;
    }
  | {
      state: 'installing-engine';
      progress: number;
      stage: string;
      message: string;
      hint: string;
    }
  | {
      state: 'starting-runtime';
      runtime: string;
      message: string;
      hint: string;
    }
  | {
      state: 'waiting-for-engine';
      message: string;
      hint: string;
    }
  | {
      state: 'stopping-engine';
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
    }
) & {
  /** Set while a user-initiated operation drives the status, so UIs can say "restarting" rather than "starting". */
  operation?: EngineStatusOperation;
};

export interface UpdateDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export type AutoUpdaterStatus =
  | {
      status: 'idle';
    }
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
  | ({
      status: 'downloading';
    } & UpdateDownloadProgress)
  | {
      status: 'downloaded';
      version: string;
    }
  | {
      status: 'error';
      message: string;
    };

export interface DockerContextItem {
  name: string;
  description: string;
  dockerEndpoint: string;
  current: boolean;
}

export interface DockerContextOverride {
  variable: 'DOCKER_HOST' | 'DOCKER_CONTEXT';
  value: string;
  source: string | null;
}

export interface DockerContextDetails {
  cliAvailable: boolean;
  envOverride?: DockerContextOverride | null;
  currentContext: string | null;
  contexts: DockerContextItem[];
  catbeeContextExists: boolean;
  isCatBeeActive: boolean;
  defaultEndpoint: string;
}

export interface BuilderInstanceDetails {
  name: string;
  driver: string;
  status: 'running' | 'stopped' | 'error';
  error?: string;
  endpoint?: string;
  isCurrent: boolean;
  storageLimit?: string;
  usedBytes?: number;
  sharedBytes?: number;
  platforms?: string[];
}

export interface DockerBuilderInfo {
  currentBuilder: string;
  builders: BuilderInstanceDetails[];
}

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

export interface ResourceSettingsConfig {
  cpus: number;
  memoryGb: number;
  swapGb: number;
  diskGb: number;
  rosetta: boolean;
}

export interface EngineSettings {
  engineMode: 'auto' | 'embedded' | 'external';
  exposeTcp: boolean;
  resourceSaverEnabled: boolean;
  resourceSaverTimeout: number;
  wslIntegrationEnabled: boolean;
  wslAdditionalDistros?: string[];
  fileSharingPaths?: string[];
  desktopProxy?: DesktopProxyConfig;
  containersProxy?: ContainersProxyConfig;
  network?: NetworkSettingsConfig;
  resources?: ResourceSettingsConfig;
  endpoint?: string;
}

export type EngineBackend = 'wsl2' | 'lima' | 'rootless';

export type EngineLifecycleState =
  'not-installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'uninstalling' | 'error';

export interface EngineCapabilities {
  backend: EngineBackend;
  backendLabel: string;
  managesVmResources: boolean;
  resources: { cpus: boolean; memory: boolean; swap: boolean; disk: boolean; rosetta: boolean };
  resourcesNote?: string;
  fileSharing: boolean;
  fileSharingNote?: string;
  wslIntegration: boolean;
  resourceChangesRequireRestart: boolean;
  resourceSaver: boolean;
}

export interface EngineInfo {
  capabilities: EngineCapabilities;
  engineDir: string;
  dataLocation: string;
  logsLocation: string;
  daemonConfigLocation: string;
  distribution: string;
}

export interface EngineManifest {
  schemaVersion: number;
  backend: EngineBackend;
  engineVersion: string;
  components?: Record<string, string>;
  platform: 'win32' | 'darwin' | 'linux';
  architecture: 'x64' | 'arm64';
  distribution: string;
  installedAt: string;
  updatedAt?: string;
}

export interface EngineOperationProgress {
  operation: 'install' | 'uninstall';
  /** 0-100 */
  progress: number;
  stage: string;
}

export interface EmbeddedEngineStatus {
  isInstalled: boolean;
  state: EngineLifecycleState;
  manifest: EngineManifest | null;
  runtime: { source: 'external' | 'embedded'; runtimeName: string } | null;
  endpoint: string | null;
  exposedTcpEndpoint: string | null;
  lastError: string | null;
  operation?: EngineOperationProgress | null;
  info: EngineInfo;
}

export interface ElectronBridge {
  app: {
    platform: {
      get: () => IpcPromise<string>;
      getInfo: () => IpcPromise<{
        platform: string;
        arch: string;
        appVersion: string;
        electronVersion: string;
        nodeVersion: string;
        osRelease: string;
        osType: string;
        totalMemory: number;
        cpuCount: number;
        freeDiskGb?: number | null;
      }>;
      openLogs: () => IpcPromise<{ opened: boolean }>;
      openEngineDir: () => IpcPromise<{ opened: boolean; path: string }>;
      getStartAtLogin?: () => IpcPromise<boolean>;
      setStartAtLogin?: (enabled: boolean) => IpcPromise<boolean>;
    };
    external: {
      open: (url: string) => IpcPromise<{ opened: boolean }>;
    };
    shell: {
      showItem: (path: string) => IpcPromise<{ shown: boolean }>;
    };
    dialog: {
      selectDirectory: () => IpcPromise<{ path: string | null }>;
    };
    window?: {
      minimize: () => IpcPromise<{ minimized: boolean }>;
      getState: () => IpcPromise<{ maximized: boolean; fullscreen: boolean }>;
      toggleMaximize: () => IpcPromise<{ maximized: boolean }>;
      close: () => IpcPromise<{ closed: boolean }>;
    };
    quit?: () => IpcPromise<{ quit: boolean }>;
    onNavigate?: (callback: (payload: { path: string; queryParams?: Record<string, string> }) => void) => () => void;
    onQuitting?: (callback: () => void) => () => void;
    menu: {
      show: () => IpcPromise<{ shown: boolean }>;
      showSubmenu: (label: string) => IpcPromise<{ shown: boolean }>;
    };
    initialization: {
      docker: {
        onStatus: (callback: (status: DockerInitializationStatus) => void) => () => void;
      };
      rendererReady: () => void;
    };
    engine: {
      install: () => IpcPromise<{ success: boolean }>;
      start: () => IpcPromise<{ success: boolean }>;
      stop: () => IpcPromise<{ success: boolean }>;
      restart: (mode?: string) => IpcPromise<{ success: boolean }>;
      pause?: () => IpcPromise<{ pausedCount: number; isPaused: boolean }>;
      resume?: () => IpcPromise<{ resumedCount: number; isPaused: boolean }>;
      getPauseStatus?: () => IpcPromise<{ isPaused: boolean; pausedCount: number }>;
      getStatus: () => IpcPromise<EmbeddedEngineStatus>;
      checkPrerequisites: () => IpcPromise<{ ok: boolean; reason?: string; actionHint?: string }>;
      getContextInfo: () => IpcPromise<DockerContextDetails>;
      useContext: (contextName: string) => IpcPromise<DockerContextDetails>;
      setupCatBeeContext: (setAsActive?: boolean, customEndpoint?: string) => IpcPromise<DockerContextDetails>;
      getSettings: () => IpcPromise<EngineSettings>;
      saveSettings: (settings: Partial<EngineSettings>) => IpcPromise<EngineSettings>;
      getWslDistros: () => IpcPromise<string[]>;
      applyWslDistroIntegration: (distroName: string, enabled: boolean) => IpcPromise<boolean>;
      uninstall?: () => IpcPromise<{ success: boolean }>;
      onProgress?: (callback: (progress: EngineOperationProgress | null) => void) => () => void;
      applySettings?: () => IpcPromise<{ applied: boolean }>;
      getDaemonConfig?: (settings?: Partial<EngineSettings>) => IpcPromise<Record<string, unknown>>;
      getBuilderInfo?: () => IpcPromise<DockerBuilderInfo>;
    };
    updater: {
      checkForUpdates: () => IpcPromise<void>;
      downloadUpdate: () => IpcPromise<void>;
      restartAndInstallUpdate: () => IpcPromise<void>;
      onStatus: (callback: (status: AutoUpdaterStatus) => void) => () => void;
      isMicrosoftStore: () => IpcPromise<boolean>;
    };
  };
  docker: {
    engine: {
      ping: () => IpcPromise<boolean>;
      info: () => IpcPromise<unknown>;
      version: () => IpcPromise<unknown>;
      diskUsage: () => IpcPromise<unknown>;
      events: (options?: Docker.GetEventsOptions) => IpcPromise<unknown>;
      pruneSystem: () => IpcPromise<unknown>;
    };
    containers: {
      list: (options?: Docker.ContainerListOptions) => IpcPromise<DockerContainerInfo[]>;
      inspect: (containerId: string) => IpcPromise<DockerContainerInspectInfo>;
      create: (options: Docker.ContainerCreateOptions) => IpcPromise<DockerContainerInspectInfo>;
      start: (containerId: string) => IpcPromise<DockerActionResult>;
      stop: (containerId: string) => IpcPromise<DockerActionResult>;
      restart: (containerId: string) => IpcPromise<DockerActionResult>;
      recreate: (containerId: string, options?: RecreateContainerOptions) => IpcPromise<DockerActionResult>;
      recreateComposeGroup: (options: {
        workingDir: string;
        configFiles?: string[];
        projectName?: string;
        service?: string;
        services?: string[];
      }) => IpcPromise<DockerActionResult>;
      update: (containerId: string, options: { restartPolicy?: string }) => IpcPromise<void>;
      pause: (containerId: string) => IpcPromise<DockerActionResult>;
      unpause: (containerId: string) => IpcPromise<DockerActionResult>;
      wait: (containerId: string, options?: Docker.ContainerWaitOptions) => IpcPromise<unknown>;
      exec: (containerId: string, command: string[]) => IpcPromise<DockerActionResult>;
      remove: (containerId: string, force?: boolean) => IpcPromise<DockerActionResult>;
      stats: (containerId: string) => IpcPromise<DockerContainerStats>;
      files: {
        list: (containerId: string, path?: string) => IpcPromise<DockerFileEntry[]>;
        read: (containerId: string, path: string) => IpcPromise<Uint8Array>;
        upload: (containerId: string, path: string, data: Uint8Array) => IpcPromise<void>;
        createDirectory: (containerId: string, path: string) => IpcPromise<void>;
        delete: (containerId: string, path: string) => IpcPromise<void>;
        rename: (containerId: string, path: string, newPath: string) => IpcPromise<void>;
      };
    };
    streams: {
      startLogs: (
        containerId: string,
        options?: Omit<Docker.ContainerLogsOptions, 'follow'>
      ) => IpcPromise<StreamStartResult>;
      startStats: (containerId: string) => IpcPromise<StreamStartResult>;
      startEvents: (options?: Docker.GetEventsOptions) => IpcPromise<StreamStartResult>;
      startPull: (image: string, options?: Record<string, never>) => IpcPromise<StreamStartResult>;
      stop: (streamId: string) => IpcPromise<unknown>;
      onEvent: (callback: (payload: unknown) => void) => () => void;
    };
    images: {
      list: (options?: Docker.ListImagesOptions) => IpcPromise<DockerImageInfo[]>;
      inspect: (imageId: string) => IpcPromise<DockerImageInspectInfo>;
      remove: (imageId: string, force?: boolean, pruneChildren?: boolean) => IpcPromise<unknown>;
      prune: (filters?: Record<string, string[]>) => IpcPromise<unknown>;
      history: (imageId: string) => IpcPromise<DockerImageHistoryInfo[]>;
    };
    volumes: {
      list: (options?: Docker.VolumeListOptions) => IpcPromise<{ Volumes?: DockerVolumeInfo[] }>;
      inspect: (name: string) => IpcPromise<DockerVolumeInfo>;
      usage: (name?: string) => IpcPromise<Record<string, DockerVolumeUsage>>;
      create: (options: Docker.VolumeCreateOptions) => IpcPromise<DockerVolumeInfo>;
      remove: (name: string, force?: boolean) => IpcPromise<unknown>;
      prune: (filters?: Docker.VolumePruneOptions['filters']) => IpcPromise<unknown>;
      files: {
        list: (name: string, path?: string) => IpcPromise<DockerFileEntry[]>;
        read: (name: string, path: string) => IpcPromise<Uint8Array>;
        write: (name: string, path: string, data: Uint8Array) => IpcPromise<void>;
        delete: (name: string, path: string) => IpcPromise<void>;
      };
    };
    networks: {
      list: (options?: Docker.NetworkListOptions) => IpcPromise<DockerNetworkInfo[]>;
      inspect: (networkId: string) => IpcPromise<DockerNetworkInfo>;
      create: (options: Docker.NetworkCreateOptions) => IpcPromise<DockerNetworkInfo>;
      remove: (networkId: string) => IpcPromise<void>;
      connect: (networkId: string, containerId: string) => IpcPromise<void>;
      disconnect: (networkId: string, containerId: string, force?: boolean) => IpcPromise<void>;
      prune: () => IpcPromise<unknown>;
    };
    system: {
      pruneContainers: () => IpcPromise<unknown>;
      pruneImages: (filters?: unknown) => IpcPromise<unknown>;
      pruneVolumes: (filters?: unknown) => IpcPromise<unknown>;
      pruneNetworks: () => IpcPromise<unknown>;
      pruneBuildCache: () => IpcPromise<unknown>;
    };
    execSession: {
      create: (containerId: string, command: string[], tty?: boolean) => IpcPromise<DockerExecSessionCreateResult>;
      write: (sessionId: string, data: string) => IpcPromise<{ written: boolean }>;
      resize: (sessionId: string, cols: number, rows: number) => IpcPromise<{ resized: boolean }>;
      close: (sessionId: string) => IpcPromise<{ closed: boolean }>;
    };
  };
}
