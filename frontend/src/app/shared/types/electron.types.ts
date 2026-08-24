import type Docker from 'dockerode';
import {
  DockerActionResult,
  DockerContainerInfo,
  DockerContainerInspectInfo,
  DockerContainerStats,
  DockerExecSessionCreateResult,
  DockerImageHistoryInfo,
  DockerImageInfo,
  DockerImageInspectInfo,
  DockerVolumeInfo,
  IpcResult,
  StreamStartResult
} from './docker-api.types';

type IpcPromise<T> = Promise<IpcResult<T>>;

export type DockerRuntime = 'docker-desktop' | 'rancher-desktop';

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


export interface ElectronBridge {
  app: {
    external: {
      open: (url: string) => IpcPromise<{ opened: boolean }>;
    };
    shell: {
      showItem: (path: string) => IpcPromise<{ shown: boolean }>;
    };
    window?: {
      minimize: () => IpcPromise<{ minimized: boolean }>;
      getState: () => IpcPromise<{ maximized: boolean; fullscreen: boolean }>;
      toggleMaximize: () => IpcPromise<{ maximized: boolean }>;
      close: () => IpcPromise<{ closed: boolean }>;
    };
    menu: {
      show: () => IpcPromise<{ shown: boolean }>;
      showSubmenu: (label: string) => IpcPromise<{ shown: boolean }>;
    };
    initialization: {
      docker: {
        onStatus: (callback: (status: DockerInitializationStatus) => void) => () => void;
      };
      rendererReady: () => void;
    }
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
      start: (containerId: string) => IpcPromise<DockerActionResult>;
      stop: (containerId: string) => IpcPromise<DockerActionResult>;
      restart: (containerId: string) => IpcPromise<DockerActionResult>;
      pause: (containerId: string) => IpcPromise<DockerActionResult>;
      unpause: (containerId: string) => IpcPromise<DockerActionResult>;
      wait: (containerId: string, options?: Docker.ContainerWaitOptions) => IpcPromise<unknown>;
      exec: (containerId: string, command: string[]) => IpcPromise<DockerActionResult>;
      remove: (containerId: string, force?: boolean) => IpcPromise<DockerActionResult>;
      stats: (containerId: string) => IpcPromise<DockerContainerStats>;
    };
    streams: {
      startLogs: (
        containerId: string,
        options?: Omit<Docker.ContainerLogsOptions, 'follow'>
      ) => IpcPromise<StreamStartResult>;
      startStats: (containerId: string) => IpcPromise<StreamStartResult>;
      startEvents: (options?: Docker.GetEventsOptions) => IpcPromise<StreamStartResult>;
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
      remove: (name: string, force?: boolean) => IpcPromise<unknown>;
      prune: (filters?: Docker.VolumePruneOptions['filters']) => IpcPromise<unknown>;
    };
    execSession: {
      create: (containerId: string, command: string[], tty?: boolean) => IpcPromise<DockerExecSessionCreateResult>;
      write: (sessionId: string, data: string) => IpcPromise<{ written: boolean }>;
      resize: (sessionId: string, cols: number, rows: number) => IpcPromise<{ resized: boolean }>;
      close: (sessionId: string) => IpcPromise<{ closed: boolean }>;
    };
  };
}
