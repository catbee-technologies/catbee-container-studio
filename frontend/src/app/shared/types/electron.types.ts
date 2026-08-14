export interface ElectronBridge {
  app: {
    external: {
      open: (url: string) => Promise<unknown>;
    };
    shell: {
      showItem: (path: string) => Promise<unknown>;
    };
  };
  docker: {
    containers: {
      list: (options?: unknown) => Promise<unknown>;
      inspect: (containerId: string) => Promise<unknown>;
      start: (containerId: string) => Promise<unknown>;
      stop: (containerId: string) => Promise<unknown>;
      restart: (containerId: string) => Promise<unknown>;
      pause: (containerId: string) => Promise<unknown>;
      unpause: (containerId: string) => Promise<unknown>;
      exec: (containerId: string, command: string[]) => Promise<unknown>;
      remove: (containerId: string, force?: boolean) => Promise<unknown>;
      stats: (containerId: string) => Promise<unknown>;
    };
    streams: {
      startLogs: (containerId: string, options?: unknown) => Promise<unknown>;
      startStats: (containerId: string) => Promise<unknown>;
      startEvents: (options?: unknown) => Promise<unknown>;
      stop: (streamId: string) => Promise<unknown>;
      onEvent: (callback: (payload: unknown) => void) => () => void;
    };
    images: {
      list: (options?: unknown) => Promise<unknown>;
      inspect: (imageId: string) => Promise<unknown>;
      remove: (imageId: string, force?: boolean, pruneChildren?: boolean) => Promise<unknown>;
      prune: (filters?: unknown) => Promise<unknown>;
      history: (imageId: string) => Promise<unknown>;
    };
    volumes: {
      list: (options?: unknown) => Promise<unknown>;
      inspect: (name: string) => Promise<unknown>;
      remove: (name: string, force?: boolean) => Promise<unknown>;
      prune: (filters?: unknown) => Promise<unknown>;
    };
    execSession: {
      create: (containerId: string, command: string[], tty?: boolean) => Promise<unknown>;
      write: (sessionId: string, data: string) => Promise<unknown>;
      resize: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
      close: (sessionId: string) => Promise<unknown>;
    };
  };
}
