import { contextBridge, ipcRenderer } from 'electron';

/**
 * Keep IPC channel definitions local to the sandboxed preload.
 * Sandboxed preload scripts cannot reliably load local CommonJS modules
 * when compiled with plain TypeScript (tsc), so importing from ipc/channels.ts
 * would cause the preload script to fail at runtime.
 */
const IPC_CHANNELS = {
  App: {
    External: {
      Open: 'app:external:open'
    },
    Shell: {
      ShowItem: 'app:shell:show-item'
    },
    Window: {
      Minimize: 'app:window:minimize',
      GetState: 'app:window:get-state',
      ToggleMaximize: 'app:window:toggle-maximize',
      Close: 'app:window:close'
    }
  },
  Docker: {
    Engine: {
      Ping: 'docker:engine:ping',
      Info: 'docker:engine:info',
      Version: 'docker:engine:version',
      DiskUsage: 'docker:engine:disk-usage',
      Events: 'docker:engine:events',
      PruneSystem: 'docker:engine:prune-system'
    },
    Containers: {
      List: 'docker:containers:list',
      Inspect: 'docker:containers:inspect',
      Create: 'docker:containers:create',
      Start: 'docker:containers:start',
      Stop: 'docker:containers:stop',
      Restart: 'docker:containers:restart',
      Pause: 'docker:containers:pause',
      Unpause: 'docker:containers:unpause',
      Kill: 'docker:containers:kill',
      Remove: 'docker:containers:remove',
      Rename: 'docker:containers:rename',
      Wait: 'docker:containers:wait',
      Logs: 'docker:containers:logs',
      Stats: 'docker:containers:stats',
      Top: 'docker:containers:top',
      Exec: 'docker:containers:exec',
      Ports: 'docker:containers:ports',
      Env: 'docker:containers:env',
      Mounts: 'docker:containers:mounts',
      Networks: 'docker:containers:networks'
    },
    Images: {
      List: 'docker:images:list',
      Inspect: 'docker:images:inspect',
      Pull: 'docker:images:pull',
      Push: 'docker:images:push',
      Tag: 'docker:images:tag',
      Remove: 'docker:images:remove',
      History: 'docker:images:history',
      Prune: 'docker:images:prune'
    },
    Volumes: {
      List: 'docker:volumes:list',
      Inspect: 'docker:volumes:inspect',
      Create: 'docker:volumes:create',
      Remove: 'docker:volumes:remove',
      Prune: 'docker:volumes:prune'
    },
    Networks: {
      List: 'docker:networks:list',
      Inspect: 'docker:networks:inspect',
      Create: 'docker:networks:create',
      Remove: 'docker:networks:remove',
      Connect: 'docker:networks:connect',
      Disconnect: 'docker:networks:disconnect',
      Prune: 'docker:networks:prune'
    },
    System: {
      PruneContainers: 'docker:system:prune-containers',
      PruneImages: 'docker:system:prune-images',
      PruneVolumes: 'docker:system:prune-volumes',
      PruneNetworks: 'docker:system:prune-networks',
      PruneBuildCache: 'docker:system:prune-build-cache'
    },
    Streams: {
      Event: 'docker:streams:event',
      StartLogs: 'docker:streams:start-logs',
      StartStats: 'docker:streams:start-stats',
      StartEvents: 'docker:streams:start-events',
      StartPull: 'docker:streams:start-pull',
      StartPush: 'docker:streams:start-push',
      Stop: 'docker:streams:stop'
    },
    ExecSession: {
      Create: 'docker:exec-session:create',
      Write: 'docker:exec-session:write',
      Resize: 'docker:exec-session:resize',
      Close: 'docker:exec-session:close'
    }
  }
} as const;

type DockerEngineBridge = {
  ping: () => Promise<unknown>;
  info: () => Promise<unknown>;
  version: () => Promise<unknown>;
  diskUsage: () => Promise<unknown>;
  events: (options?: unknown) => Promise<unknown>;
  pruneSystem: () => Promise<unknown>;
};

type DockerContainersBridge = {
  list: (options?: unknown) => Promise<unknown>;
  inspect: (containerId: string) => Promise<unknown>;
  create: (options: unknown) => Promise<unknown>;
  start: (containerId: string) => Promise<unknown>;
  stop: (containerId: string) => Promise<unknown>;
  restart: (containerId: string) => Promise<unknown>;
  pause: (containerId: string) => Promise<unknown>;
  unpause: (containerId: string) => Promise<unknown>;
  kill: (containerId: string) => Promise<unknown>;
  remove: (containerId: string, force?: boolean) => Promise<unknown>;
  rename: (containerId: string, newName: string) => Promise<unknown>;
  wait: (containerId: string) => Promise<unknown>;
  logs: (containerId: string, options?: unknown) => Promise<unknown>;
  stats: (containerId: string) => Promise<unknown>;
  top: (containerId: string) => Promise<unknown>;
  exec: (containerId: string, command: string[]) => Promise<unknown>;
  ports: (containerId: string) => Promise<unknown>;
  env: (containerId: string) => Promise<unknown>;
  mounts: (containerId: string) => Promise<unknown>;
  networks: (containerId: string) => Promise<unknown>;
};

type DockerImagesBridge = {
  list: (options?: unknown) => Promise<unknown>;
  inspect: (imageId: string) => Promise<unknown>;
  pull: (image: string, options?: unknown) => Promise<unknown>;
  push: (repoTag: string, options?: unknown) => Promise<unknown>;
  tag: (imageId: string, repo: string, tag: string) => Promise<unknown>;
  remove: (imageId: string, force?: boolean, pruneChildren?: boolean) => Promise<unknown>;
  history: (imageId: string) => Promise<unknown>;
  prune: (filters?: unknown) => Promise<unknown>;
};

type DockerVolumesBridge = {
  list: (options?: unknown) => Promise<unknown>;
  inspect: (name: string) => Promise<unknown>;
  create: (options: unknown) => Promise<unknown>;
  remove: (name: string, force?: boolean) => Promise<unknown>;
  prune: (filters?: unknown) => Promise<unknown>;
};

type DockerNetworksBridge = {
  list: (options?: unknown) => Promise<unknown>;
  inspect: (networkId: string) => Promise<unknown>;
  create: (options: unknown) => Promise<unknown>;
  remove: (networkId: string) => Promise<unknown>;
  connect: (networkId: string, containerId: string) => Promise<unknown>;
  disconnect: (networkId: string, containerId: string, force?: boolean) => Promise<unknown>;
  prune: () => Promise<unknown>;
};

type DockerSystemBridge = {
  pruneContainers: () => Promise<unknown>;
  pruneImages: (filters?: unknown) => Promise<unknown>;
  pruneVolumes: (filters?: unknown) => Promise<unknown>;
  pruneNetworks: () => Promise<unknown>;
  pruneBuildCache: () => Promise<unknown>;
};

type DockerStreamsBridge = {
  startLogs: (containerId: string, options?: unknown) => Promise<unknown>;
  startStats: (containerId: string) => Promise<unknown>;
  startEvents: (options?: unknown) => Promise<unknown>;
  startPull: (image: string, options?: unknown) => Promise<unknown>;
  startPush: (repoTag: string, options?: unknown) => Promise<unknown>;
  stop: (streamId: string) => Promise<unknown>;
  onEvent: (callback: (payload: unknown) => void) => () => void;
};

type DockerExecSessionBridge = {
  create: (containerId: string, command: string[], tty?: boolean) => Promise<unknown>;
  write: (sessionId: string, data: string) => Promise<unknown>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
  close: (sessionId: string) => Promise<unknown>;
};

type DockerBridge = {
  engine: DockerEngineBridge;
  containers: DockerContainersBridge;
  images: DockerImagesBridge;
  volumes: DockerVolumesBridge;
  networks: DockerNetworksBridge;
  system: DockerSystemBridge;
  streams: DockerStreamsBridge;
  execSession: DockerExecSessionBridge;
};

type ElectronBridge = {
  app: {
    external: {
      open: (url: string) => Promise<unknown>;
    };
    shell: {
      showItem: (path: string) => Promise<unknown>;
    };
    window: {
      minimize: () => Promise<unknown>;
      getState: () => Promise<unknown>;
      toggleMaximize: () => Promise<unknown>;
      close: () => Promise<unknown>;
    };
  };
  docker: DockerBridge;
};

const electronBridge: ElectronBridge = {
  app: {
    external: {
      open: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.App.External.Open, url)
    },
    shell: {
      showItem: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.App.Shell.ShowItem, path)
    },
    window: {
      minimize: () => ipcRenderer.invoke(IPC_CHANNELS.App.Window.Minimize),
      getState: () => ipcRenderer.invoke(IPC_CHANNELS.App.Window.GetState),
      toggleMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.App.Window.ToggleMaximize),
      close: () => ipcRenderer.invoke(IPC_CHANNELS.App.Window.Close)
    }
  },
  docker: {
    engine: {
      ping: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.Ping),
      info: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.Info),
      version: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.Version),
      diskUsage: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.DiskUsage),
      events: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.Events, options),
      pruneSystem: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Engine.PruneSystem)
    },
    containers: {
      list: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.List, options),
      inspect: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Inspect, containerId),
      create: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Create, options),
      start: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Start, containerId),
      stop: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Stop, containerId),
      restart: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Restart, containerId),
      pause: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Pause, containerId),
      unpause: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Unpause, containerId),
      kill: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Kill, containerId),
      remove: (containerId: string, force?: boolean) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Remove, containerId, force),
      rename: (containerId: string, newName: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Rename, containerId, newName),
      wait: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Wait, containerId),
      logs: (containerId: string, options?: unknown) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Logs, containerId, options),
      stats: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Stats, containerId),
      top: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Top, containerId),
      exec: (containerId: string, command: string[]) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Exec, containerId, command),
      ports: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Ports, containerId),
      env: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Env, containerId),
      mounts: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Mounts, containerId),
      networks: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Containers.Networks, containerId)
    },
    images: {
      list: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.List, options),
      inspect: (imageId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Inspect, imageId),
      pull: (image: string, options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Pull, image, options),
      push: (repoTag: string, options?: unknown) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Push, repoTag, options),
      tag: (imageId: string, repo: string, tag: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Tag, imageId, repo, tag),
      remove: (imageId: string, force?: boolean, pruneChildren?: boolean) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Remove, imageId, force, pruneChildren),
      history: (imageId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.History, imageId),
      prune: (filters?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Images.Prune, filters)
    },
    volumes: {
      list: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Volumes.List, options),
      inspect: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Volumes.Inspect, name),
      create: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Volumes.Create, options),
      remove: (name: string, force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Volumes.Remove, name, force),
      prune: (filters?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Volumes.Prune, filters)
    },
    networks: {
      list: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.List, options),
      inspect: (networkId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Inspect, networkId),
      create: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Create, options),
      remove: (networkId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Remove, networkId),
      connect: (networkId: string, containerId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Connect, networkId, containerId),
      disconnect: (networkId: string, containerId: string, force?: boolean) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Disconnect, networkId, containerId, force),
      prune: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.Networks.Prune)
    },
    system: {
      pruneContainers: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.System.PruneContainers),
      pruneImages: (filters?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.System.PruneImages, filters),
      pruneVolumes: (filters?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.System.PruneVolumes, filters),
      pruneNetworks: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.System.PruneNetworks),
      pruneBuildCache: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.System.PruneBuildCache)
    },
    streams: {
      startLogs: (containerId: string, options?: unknown) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.StartLogs, containerId, options),
      startStats: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.StartStats, containerId),
      startEvents: (options?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.StartEvents, options),
      startPull: (image: string, options?: unknown) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.StartPull, image, options),
      startPush: (repoTag: string, options?: unknown) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.StartPush, repoTag, options),
      stop: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.Streams.Stop, streamId),
      onEvent: (callback: (payload: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
          callback(payload);
        };

        ipcRenderer.on(IPC_CHANNELS.Docker.Streams.Event, listener);

        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.Docker.Streams.Event, listener);
        };
      }
    },
    execSession: {
      create: (containerId: string, command: string[], tty = true) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.ExecSession.Create, containerId, command, tty),
      write: (sessionId: string, data: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.ExecSession.Write, sessionId, data),
      resize: (sessionId: string, cols: number, rows: number) =>
        ipcRenderer.invoke(IPC_CHANNELS.Docker.ExecSession.Resize, sessionId, cols, rows),
      close: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.ExecSession.Close, sessionId)
    }
  }
};

contextBridge.exposeInMainWorld('electron', electronBridge);
