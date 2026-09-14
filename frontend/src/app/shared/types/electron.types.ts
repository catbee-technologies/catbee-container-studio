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
  StreamStartResult
} from './docker-api.types';

type IpcPromise<T> = Promise<IpcResult<T>>;

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop' | 'catbee-embedded' | 'system';

export type DockerInitializationStatus =
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
      state: 'ready';
      message: string;
      hint: string;
    }
  | {
      state: 'error';
      message: string;
      hint: string;
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

export interface DockerContextDetails {
  cliAvailable: boolean;
  currentContext: string | null;
  contexts: DockerContextItem[];
  catbeeContextExists: boolean;
  isCatBeeActive: boolean;
  defaultEndpoint: string;
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
  wslAdditionalDistros?: string[];
  fileSharingPaths?: string[];
  desktopProxy?: DesktopProxyConfig;
  containersProxy?: ContainersProxyConfig;
  network?: NetworkSettingsConfig;
  endpoint?: string;
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
      }>;
      openLogs: () => IpcPromise<{ opened: boolean }>;
      openEngineDir: () => IpcPromise<{ opened: boolean; path: string }>;
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
      getStatus: () => IpcPromise<{ isInstalled: boolean; state: string; manifest: unknown; runtime: unknown }>;
      checkPrerequisites: () => IpcPromise<{ ok: boolean; reason?: string; actionHint?: string }>;
      getContextInfo: () => IpcPromise<DockerContextDetails>;
      useContext: (contextName: string) => IpcPromise<DockerContextDetails>;
      setupCatBeeContext: (setAsActive?: boolean, customEndpoint?: string) => IpcPromise<DockerContextDetails>;
      getSettings: () => IpcPromise<EngineSettings>;
      saveSettings: (settings: Partial<EngineSettings>) => IpcPromise<EngineSettings>;
      getWslDistros: () => IpcPromise<string[]>;
      applyWslDistroIntegration: (distroName: string, enabled: boolean) => IpcPromise<boolean>;
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
    execSession: {
      create: (containerId: string, command: string[], tty?: boolean) => IpcPromise<DockerExecSessionCreateResult>;
      write: (sessionId: string, data: string) => IpcPromise<{ written: boolean }>;
      resize: (sessionId: string, cols: number, rows: number) => IpcPromise<{ resized: boolean }>;
      close: (sessionId: string) => IpcPromise<{ closed: boolean }>;
    };
  };
}
