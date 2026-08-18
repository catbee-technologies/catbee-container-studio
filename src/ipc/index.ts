import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, shell } from 'electron';
import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { DockerService } from '../main/docker/docker.service';
import { IPC_CHANNELS } from './channels';
import { DockerStreamEventEnvelope, IpcResult, fail, ok } from './contracts';

export const dockerService = new DockerService();

type StreamSession = {
  ownerWebContentsId: number;
  abortController?: AbortController;
  stop: () => void;
};

type ExecSession = {
  ownerWebContentsId: number;
  execId: string;
  stream: NodeJS.ReadWriteStream;
  stop: () => void;
};

const streamSessions = new Map<string, StreamSession>();
const execSessions = new Map<string, ExecSession>();

function registerHandle<T>(channel: string, handler: (...args: any[]) => Promise<T>): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, ...args: any[]): Promise<IpcResult<T>> => {
    try {
      const result = await handler(...args);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  });
}

function emitStreamEvent<T>(webContents: Electron.WebContents, payload: DockerStreamEventEnvelope<T>): void {
  if (webContents.isDestroyed()) {
    return;
  }

  webContents.send(IPC_CHANNELS.Docker.Streams.Event, payload);
}

function buildStreamEvent<T>(
  streamId: string,
  kind: DockerStreamEventEnvelope<T>['kind'],
  type: DockerStreamEventEnvelope<T>['type'],
  partial: Omit<DockerStreamEventEnvelope<T>, 'streamId' | 'kind' | 'type' | 'timestamp'>
): DockerStreamEventEnvelope<T> {
  return {
    streamId,
    kind,
    type,
    timestamp: new Date().toISOString(),
    ...partial
  };
}

function stopStreamSession(streamId: string): boolean {
  const session = streamSessions.get(streamId);
  if (!session) {
    return false;
  }

  session.abortController?.abort();
  session.stop();
  streamSessions.delete(streamId);
  return true;
}

function stopExecSession(sessionId: string): boolean {
  const session = execSessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.stop();
  execSessions.delete(sessionId);
  return true;
}

function tryDestroyStream(stream: NodeJS.ReadableStream | NodeJS.ReadWriteStream): void {
  const destroyable = stream as {
    destroy?: () => void;
  };

  destroyable.destroy?.();
}

function tryEndStream(stream: NodeJS.ReadWriteStream): void {
  const endable = stream as {
    end?: () => void;
  };

  endable.end?.();
}

function wireTextStream(
  webContents: Electron.WebContents,
  streamId: string,
  kind: DockerStreamEventEnvelope['kind'],
  stream: NodeJS.ReadableStream,
  channel?: DockerStreamEventEnvelope['channel']
): void {
  stream.on('data', (chunk: Buffer | string) => {
    emitStreamEvent(
      webContents,
      buildStreamEvent(streamId, kind, 'data', {
        channel,
        data: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      })
    );
  });
}

function wireJsonLineStream(
  webContents: Electron.WebContents,
  streamId: string,
  kind: DockerStreamEventEnvelope['kind'],
  stream: NodeJS.ReadableStream
): void {
  let pending = '';

  stream.on('data', (chunk: Buffer | string) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';

    for (const line of lines) {
      const normalized = line.trim();
      if (!normalized) {
        continue;
      }

      try {
        emitStreamEvent(
          webContents,
          buildStreamEvent(streamId, kind, 'data', {
            data: JSON.parse(normalized)
          })
        );
      } catch {
        emitStreamEvent(
          webContents,
          buildStreamEvent(streamId, kind, 'data', {
            data: {
              raw: normalized
            }
          })
        );
      }
    }

    const candidate = pending.trim();
    if (candidate) {
      try {
        emitStreamEvent(
          webContents,
          buildStreamEvent(streamId, kind, 'data', {
            data: JSON.parse(candidate)
          })
        );
        pending = '';
      } catch {
        // Keep buffering until a complete JSON object is available.
      }
    }
  });

  stream.on('end', () => {
    const normalized = pending.trim();
    if (!normalized) {
      return;
    }

    try {
      emitStreamEvent(
        webContents,
        buildStreamEvent(streamId, kind, 'data', {
          data: JSON.parse(normalized)
        })
      );
    } catch {
      emitStreamEvent(
        webContents,
        buildStreamEvent(streamId, kind, 'data', {
          data: {
            raw: normalized
          }
        })
      );
    }
  });
}

export function registerIpcHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.External.Open);
  ipcMain.handle(
    IPC_CHANNELS.App.External.Open,
    async (_event, url: string): Promise<IpcResult<{ opened: boolean }>> => {
      if (!url || typeof url !== 'string') {
        return fail(new Error('Invalid URL.'));
      }

      await shell.openExternal(url);
      return ok({ opened: true });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Shell.ShowItem);
  ipcMain.handle(IPC_CHANNELS.App.Shell.ShowItem, (_event, path: string): IpcResult<{ shown: boolean }> => {
    if (!path || typeof path !== 'string') {
      return fail(new Error('Invalid path.'));
    }

    shell.showItemInFolder(path);
    return ok({ shown: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.Minimize);
  ipcMain.handle(IPC_CHANNELS.App.Window.Minimize, async (event): Promise<IpcResult<{ minimized: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }

    window.minimize();
    return ok({ minimized: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.GetState);
  ipcMain.handle(
    IPC_CHANNELS.App.Window.GetState,
    async (event): Promise<IpcResult<{ maximized: boolean; fullscreen: boolean }>> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return fail(new Error('Window not found.'));
      }

      return ok({
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen()
      });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.ToggleMaximize);
  ipcMain.handle(IPC_CHANNELS.App.Window.ToggleMaximize, async (event): Promise<IpcResult<{ maximized: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return ok({ maximized: false });
    }

    window.maximize();
    return ok({ maximized: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Window.Close);
  ipcMain.handle(IPC_CHANNELS.App.Window.Close, async (event): Promise<IpcResult<{ closed: boolean }>> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return fail(new Error('Window not found.'));
    }

    window.close();
    return ok({ closed: true });
  });

  registerHandle(IPC_CHANNELS.Docker.Engine.Ping, () => dockerService.ping());
  registerHandle(IPC_CHANNELS.Docker.Engine.Info, () => dockerService.info());
  registerHandle(IPC_CHANNELS.Docker.Engine.Version, () => dockerService.version());
  registerHandle(IPC_CHANNELS.Docker.Engine.DiskUsage, () => dockerService.diskUsage());
  registerHandle(IPC_CHANNELS.Docker.Engine.Events, (options?: Docker.GetEventsOptions) =>
    dockerService.events(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Engine.PruneSystem, () => dockerService.pruneSystem());

  registerHandle(IPC_CHANNELS.Docker.Containers.List, (options?: Docker.ContainerListOptions) =>
    dockerService.listContainers(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Inspect, (containerId: string) =>
    dockerService.inspectContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Create, (options: Docker.ContainerCreateOptions) =>
    dockerService.createContainer(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Start, (containerId: string) =>
    dockerService.startContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Stop, (containerId: string) =>
    dockerService.stopContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Restart, (containerId: string) =>
    dockerService.restartContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Pause, (containerId: string) =>
    dockerService.pauseContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Unpause, (containerId: string) =>
    dockerService.unpauseContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Kill, (containerId: string) =>
    dockerService.killContainer(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Remove, (containerId: string, force?: boolean) =>
    dockerService.removeContainer(containerId, force)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Rename, (containerId: string, newName: string) =>
    dockerService.renameContainer(containerId, newName)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Wait, (containerId: string, options?: Docker.ContainerWaitOptions) =>
    dockerService.waitContainer(containerId, options)
  );
  registerHandle(
    IPC_CHANNELS.Docker.Containers.Logs,
    (containerId: string, options?: Omit<Docker.ContainerLogsOptions, 'follow'>) =>
      dockerService.logs(containerId, options)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Stats, (containerId: string) => dockerService.stats(containerId));
  registerHandle(IPC_CHANNELS.Docker.Containers.Top, (containerId: string) => dockerService.top(containerId));
  registerHandle(IPC_CHANNELS.Docker.Containers.Exec, (containerId: string, command: string[]) =>
    dockerService.runExec(containerId, command)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Ports, (containerId: string) =>
    dockerService.getContainerPorts(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Env, (containerId: string) =>
    dockerService.getContainerEnv(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Mounts, (containerId: string) =>
    dockerService.getContainerMounts(containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Containers.Networks, (containerId: string) =>
    dockerService.getContainerNetworks(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Images.List, (options?: Docker.ListImagesOptions) =>
    dockerService.listImages(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Images.Inspect, (imageId: string) => dockerService.inspectImage(imageId));
  registerHandle(IPC_CHANNELS.Docker.Images.Pull, (image: string, options?: {}) =>
    dockerService.pullImage(image, options)
  );
  registerHandle(IPC_CHANNELS.Docker.Images.Push, (repoTag: string, options?: Docker.ImagePushOptions) =>
    dockerService.pushImage(repoTag, options)
  );
  registerHandle(IPC_CHANNELS.Docker.Images.Tag, (imageId: string, repo: string, tag: string) =>
    dockerService.tagImage(imageId, repo, tag)
  );
  registerHandle(IPC_CHANNELS.Docker.Images.Remove, (imageId: string, force?: boolean, pruneChildren?: boolean) =>
    dockerService.removeImage(imageId, force, pruneChildren)
  );
  registerHandle(IPC_CHANNELS.Docker.Images.History, (imageId: string) => dockerService.historyImage(imageId));
  registerHandle(IPC_CHANNELS.Docker.Images.Prune, (filters?: { [key: string]: string[] }) =>
    dockerService.pruneImages(filters)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.List, (options?: Docker.VolumeListOptions) =>
    dockerService.listVolumes(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Volumes.Inspect, (name: string) => dockerService.inspectVolume(name));
  registerHandle(IPC_CHANNELS.Docker.Volumes.Create, (options: Docker.VolumeCreateOptions) =>
    dockerService.createVolume(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Volumes.Remove, (name: string, force?: boolean) =>
    dockerService.removeVolume(name, force)
  );
  registerHandle(IPC_CHANNELS.Docker.Volumes.Prune, (filters?: { [key: string]: string[] }) =>
    dockerService.pruneVolumes(filters)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.List, (options?: Docker.NetworkListOptions) =>
    dockerService.listNetworks(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Networks.Inspect, (networkId: string) => dockerService.inspectNetwork(networkId));
  registerHandle(IPC_CHANNELS.Docker.Networks.Create, (options: Docker.NetworkCreateOptions) =>
    dockerService.createNetwork(options)
  );
  registerHandle(IPC_CHANNELS.Docker.Networks.Remove, (networkId: string) => dockerService.removeNetwork(networkId));
  registerHandle(IPC_CHANNELS.Docker.Networks.Connect, (networkId: string, containerId: string) =>
    dockerService.connectNetwork(networkId, containerId)
  );
  registerHandle(IPC_CHANNELS.Docker.Networks.Disconnect, (networkId: string, containerId: string, force?: boolean) =>
    dockerService.disconnectNetwork(networkId, containerId, force)
  );
  registerHandle(IPC_CHANNELS.Docker.Networks.Prune, () => dockerService.pruneNetworks());

  registerHandle(IPC_CHANNELS.Docker.System.PruneContainers, () => dockerService.pruneContainers());
  registerHandle(IPC_CHANNELS.Docker.System.PruneImages, (filters?: { [key: string]: string[] }) =>
    dockerService.pruneImages(filters)
  );
  registerHandle(IPC_CHANNELS.Docker.System.PruneVolumes, (filters?: { [key: string]: string[] }) =>
    dockerService.pruneVolumes(filters)
  );
  registerHandle(IPC_CHANNELS.Docker.System.PruneNetworks, () => dockerService.pruneNetworks());
  registerHandle(IPC_CHANNELS.Docker.System.PruneBuildCache, () => dockerService.pruneBuildCache());

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartLogs);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartLogs,
    async (
      event,
      containerId: string,
      options?: Omit<Docker.ContainerLogsOptions, 'follow'>
    ): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const streamId = randomUUID();
        const stream = await dockerService.streamLogs(containerId, options);
        const inspect = await dockerService.inspectContainer(containerId);
        const isTty = inspect.Config.Tty === true;
        const ownerWebContentsId = event.sender.id;
        const stdout = new PassThrough();
        const stderr = new PassThrough();

        const cleanup = (): void => {
          stream.removeAllListeners();
          stdout.removeAllListeners();
          stderr.removeAllListeners();
          streamSessions.delete(streamId);
        };

        if (isTty) {
          wireTextStream(event.sender, streamId, 'logs', stream, 'stdout');
        } else {
          dockerService.demuxStream(stream, stdout, stderr);
          wireTextStream(event.sender, streamId, 'logs', stdout, 'stdout');
          wireTextStream(event.sender, streamId, 'logs', stderr, 'stderr');
        }

        stream.on('error', (error: Error) => {
          emitStreamEvent(
            event.sender,
            buildStreamEvent(streamId, 'logs', 'error', {
              error: error.message
            })
          );
          cleanup();
        });

        stream.on('end', () => {
          emitStreamEvent(event.sender, buildStreamEvent(streamId, 'logs', 'end', {}));
          cleanup();
        });

        streamSessions.set(streamId, {
          ownerWebContentsId,
          stop: () => {
            tryDestroyStream(stream);
          }
        });

        event.sender.once('destroyed', () => {
          stopStreamSession(streamId);
        });

        return ok({ streamId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartStats);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartStats,
    async (event, containerId: string): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const streamId = randomUUID();
        const stream = await dockerService.streamStats(containerId);
        const ownerWebContentsId = event.sender.id;

        const cleanup = (): void => {
          stream.removeAllListeners();
          streamSessions.delete(streamId);
        };

        wireJsonLineStream(event.sender, streamId, 'stats', stream);

        stream.on('error', (error: Error) => {
          emitStreamEvent(
            event.sender,
            buildStreamEvent(streamId, 'stats', 'error', {
              error: error.message
            })
          );
          cleanup();
        });

        stream.on('end', () => {
          emitStreamEvent(event.sender, buildStreamEvent(streamId, 'stats', 'end', {}));
          cleanup();
        });

        streamSessions.set(streamId, {
          ownerWebContentsId,
          stop: () => {
            tryDestroyStream(stream);
          }
        });

        event.sender.once('destroyed', () => {
          stopStreamSession(streamId);
        });

        return ok({ streamId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartEvents);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartEvents,
    async (event, options?: Docker.GetEventsOptions): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const streamId = randomUUID();
        const stream = await dockerService.streamEvents(options);
        const ownerWebContentsId = event.sender.id;

        const cleanup = (): void => {
          stream.removeAllListeners();
          streamSessions.delete(streamId);
        };

        wireJsonLineStream(event.sender, streamId, 'events', stream);

        stream.on('error', (error: Error) => {
          emitStreamEvent(
            event.sender,
            buildStreamEvent(streamId, 'events', 'error', {
              error: error.message
            })
          );
          cleanup();
        });

        stream.on('end', () => {
          emitStreamEvent(event.sender, buildStreamEvent(streamId, 'events', 'end', {}));
          cleanup();
        });

        streamSessions.set(streamId, {
          ownerWebContentsId,
          stop: () => {
            tryDestroyStream(stream);
          }
        });

        event.sender.once('destroyed', () => {
          stopStreamSession(streamId);
        });

        return ok({ streamId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartPull);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartPull,
    async (event, image: string, options?: {}): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const streamId = randomUUID();
        const ownerWebContentsId = event.sender.id;
        const abortController = new AbortController();
        let active = true;

        streamSessions.set(streamId, {
          ownerWebContentsId,
          abortController,
          stop: () => {
            active = false;
          }
        });

        event.sender.once('destroyed', () => {
          stopStreamSession(streamId);
        });

        void dockerService
          .pullImageWithProgress(image, { ...(options ?? {}), abortSignal: abortController.signal }, progress => {
            if (!active) {
              return;
            }

            emitStreamEvent(event.sender, buildStreamEvent(streamId, 'pull', 'data', { data: progress }));
          })
          .then(result => {
            if (!active) {
              return;
            }

            emitStreamEvent(event.sender, buildStreamEvent(streamId, 'pull', 'end', { data: result }));
          })
          .catch((error: Error) => {
            if (!active) {
              return;
            }

            emitStreamEvent(
              event.sender,
              buildStreamEvent(streamId, 'pull', 'error', {
                error: error.message
              })
            );
          })
          .finally(() => {
            streamSessions.delete(streamId);
          });

        return ok({ streamId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartPush);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartPush,
    async (event, repoTag: string, options?: Docker.ImagePushOptions): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const streamId = randomUUID();
        const ownerWebContentsId = event.sender.id;
        const abortController = new AbortController();
        let active = true;

        streamSessions.set(streamId, {
          ownerWebContentsId,
          abortController,
          stop: () => {
            active = false;
          }
        });

        event.sender.once('destroyed', () => {
          stopStreamSession(streamId);
        });

        void dockerService
          .pushImageWithProgress(repoTag, { ...(options ?? {}), abortSignal: abortController.signal }, progress => {
            if (!active) {
              return;
            }

            emitStreamEvent(event.sender, buildStreamEvent(streamId, 'push', 'data', { data: progress }));
          })
          .then(result => {
            if (!active) {
              return;
            }

            emitStreamEvent(event.sender, buildStreamEvent(streamId, 'push', 'end', { data: result }));
          })
          .catch((error: Error) => {
            if (!active) {
              return;
            }

            emitStreamEvent(
              event.sender,
              buildStreamEvent(streamId, 'push', 'error', {
                error: error.message
              })
            );
          })
          .finally(() => {
            streamSessions.delete(streamId);
          });

        return ok({ streamId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.Stop);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.Stop,
    async (_event, streamId: string): Promise<IpcResult<{ stopped: boolean }>> => {
      return ok({
        stopped: stopStreamSession(streamId)
      });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.ExecSession.Create);
  ipcMain.handle(
    IPC_CHANNELS.Docker.ExecSession.Create,
    async (
      event,
      containerId: string,
      command: string[],
      tty = true
    ): Promise<IpcResult<{ sessionId: string; execId: string }>> => {
      try {
        const sessionId = randomUUID();
        const ownerWebContentsId = event.sender.id;
        const { execId, stream } = await dockerService.createExecSession(containerId, command, tty);

        const cleanup = (): void => {
          stream.removeAllListeners();
          execSessions.delete(sessionId);
        };

        wireTextStream(event.sender, sessionId, 'exec', stream);

        stream.on('error', (error: Error) => {
          emitStreamEvent(
            event.sender,
            buildStreamEvent(sessionId, 'exec', 'error', {
              error: error.message
            })
          );
          cleanup();
        });

        stream.on('end', () => {
          emitStreamEvent(event.sender, buildStreamEvent(sessionId, 'exec', 'end', {}));
          cleanup();
        });

        execSessions.set(sessionId, {
          ownerWebContentsId,
          execId,
          stream,
          stop: () => {
            tryEndStream(stream);
            tryDestroyStream(stream);
          }
        });

        event.sender.once('destroyed', () => {
          stopExecSession(sessionId);
        });

        return ok({
          sessionId,
          execId
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.ExecSession.Write);
  ipcMain.handle(
    IPC_CHANNELS.Docker.ExecSession.Write,
    async (_event, sessionId: string, data: string): Promise<IpcResult<{ written: boolean }>> => {
      const session = execSessions.get(sessionId);

      if (!session) {
        return fail(new Error('Exec session not found.'));
      }

      session.stream.write(data);

      return ok({
        written: true
      });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.ExecSession.Resize);
  ipcMain.handle(
    IPC_CHANNELS.Docker.ExecSession.Resize,
    async (_event, sessionId: string, cols: number, rows: number): Promise<IpcResult<{ resized: boolean }>> => {
      const session = execSessions.get(sessionId);

      if (!session) {
        return fail(new Error('Exec session not found.'));
      }

      await dockerService.resizeExecSession(session.execId, cols, rows);

      return ok({
        resized: true
      });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.ExecSession.Close);
  ipcMain.handle(
    IPC_CHANNELS.Docker.ExecSession.Close,
    async (_event, sessionId: string): Promise<IpcResult<{ closed: boolean }>> => {
      return ok({
        closed: stopExecSession(sessionId)
      });
    }
  );
}
