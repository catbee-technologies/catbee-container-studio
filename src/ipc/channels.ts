export const IPC_CHANNELS = {
  App: {
    Platform: {
      Get: 'app:platform:get'
    },
    External: {
      Open: 'app:external:open'
    },
    Shell: {
      ShowItem: 'app:shell:show-item'
    },
    Dialog: {
      SelectDirectory: 'app:dialog:select-directory'
    },
    Window: {
      Minimize: 'app:window:minimize',
      GetState: 'app:window:get-state',
      ToggleMaximize: 'app:window:toggle-maximize',
      Close: 'app:window:close'
    },
    Menu: {
      Show: 'app:menu:show',
      ShowSubmenu: 'app:menu:show-submenu'
    },
    Initialization: {
      Docker: {
        Status: 'app:initialization:docker:status'
      },
      RendererReady: 'app:initialization:renderer-ready'
    },
    Updater: {
      CheckForUpdates: 'app:updater:check-for-updates',
      DownloadUpdate: 'app:updater:download-update',
      RestartAndInstallUpdate: 'app:updater:restart-and-install-update',
      Status: 'app:updater:status'
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
      Networks: 'docker:containers:networks',
      Files: {
        List: 'docker:containers:files:list',
        Read: 'docker:containers:files:read',
        Upload: 'docker:containers:files:upload',
        CreateDirectory: 'docker:containers:files:create-directory',
        Delete: 'docker:containers:files:delete',
        Rename: 'docker:containers:files:rename'
      }
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
      Usage: 'docker:volumes:usage',
      Create: 'docker:volumes:create',
      Remove: 'docker:volumes:remove',
      Prune: 'docker:volumes:prune',
      Files: {
        List: 'docker:volumes:files:list',
        Read: 'docker:volumes:files:read',
        Write: 'docker:volumes:files:write',
        Delete: 'docker:volumes:files:delete'
      }
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
