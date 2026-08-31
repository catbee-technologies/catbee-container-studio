import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { ipcMain } from 'electron';
import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, fail, ok, type DockerStreamKind } from '../contracts';
import { dockerManager } from '../../main/docker/services/docker.manager';
import {
  buildStreamEvent,
  emitStreamEvent,
  tryDestroyStream,
  wireJsonLineStream,
  wireTextStream
} from './utils/stream.utils';

type StreamSession = {
  ownerWebContentsId: number;
  abortController?: AbortController;
  stop: () => void;
};

const streamSessions = new Map<string, StreamSession>();

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

interface StreamHandlerContext {
  streamId: string;
  sender: Electron.WebContents;
}

type StreamSetupFn = (context: StreamHandlerContext, stream: NodeJS.ReadableStream) => void;

function createStreamHandler(
  streamType: DockerStreamKind,
  streamProducer: () => Promise<NodeJS.ReadableStream>,
  setupStream: StreamSetupFn,
  event: Electron.IpcMainInvokeEvent
): Promise<IpcResult<{ streamId: string }>> {
  return (async () => {
    try {
      const streamId = randomUUID();
      const stream = await streamProducer();
      const ownerWebContentsId = event.sender.id;

      const cleanup = (): void => {
        stream.removeAllListeners();
        streamSessions.delete(streamId);
      };

      streamSessions.set(streamId, {
        ownerWebContentsId,
        stop: () => {
          tryDestroyStream(stream);
        }
      });

      event.sender.once('destroyed', () => {
        stopStreamSession(streamId);
      });

      setupStream({ streamId, sender: event.sender }, stream);

      stream.on('error', (error: Error) => {
        emitStreamEvent(
          event.sender,
          buildStreamEvent(streamId, streamType, 'error', {
            error: error.message
          })
        );
        cleanup();
      });

      stream.on('end', () => {
        emitStreamEvent(event.sender, buildStreamEvent(streamId, streamType, 'end', {}));
        cleanup();
      });

      return ok({ streamId });
    } catch (error) {
      return fail(error);
    }
  })();
}

type ProgressCallback<T> = (progress: T) => void;

function createProgressHandler<TProgress, TResult>(
  streamType: DockerStreamKind,
  operationProducer: (abortSignal: AbortSignal, onProgress: ProgressCallback<TProgress>) => Promise<TResult>,
  event: Electron.IpcMainInvokeEvent
): Promise<IpcResult<{ streamId: string }>> {
  return (async () => {
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

      void operationProducer(abortController.signal, progress => {
        if (!active) return;

        emitStreamEvent(event.sender, buildStreamEvent(streamId, streamType, 'data', { data: progress }));
      })
        .then(result => {
          if (!active) return;

          emitStreamEvent(event.sender, buildStreamEvent(streamId, streamType, 'end', { data: result }));
        })
        .catch((error: Error) => {
          if (!active) return;

          emitStreamEvent(
            event.sender,
            buildStreamEvent(streamId, streamType, 'error', {
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
  })();
}

export function registerDockerStreamHandlers(): void {
  registerLogs();
  registerStats();
  registerEvents();
  registerPull();
  registerPush();
  registerStop();
}

function registerLogs(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartLogs);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartLogs,
    async (
      event,
      containerId: string,
      options?: Omit<Docker.ContainerLogsOptions, 'follow'>
    ): Promise<IpcResult<{ streamId: string }>> => {
      try {
        const inspect = await dockerManager.containers.inspectContainer(containerId);

        const isTty = inspect.Config.Tty === true;

        return createStreamHandler(
          'logs',
          () => dockerManager.containers.streamLogs(containerId, options),
          (context, stream) => {
            if (isTty) {
              wireTextStream(context.sender, context.streamId, 'logs', stream, 'stdout');

              return;
            }

            const stdout = new PassThrough();
            const stderr = new PassThrough();

            dockerManager.exec.demuxStream(stream, stdout, stderr);
            wireTextStream(context.sender, context.streamId, 'logs', stdout, 'stdout');
            wireTextStream(context.sender, context.streamId, 'logs', stderr, 'stderr');
          },
          event
        );
      } catch (error) {
        return fail(error);
      }
    }
  );
}

function registerStats(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartStats);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartStats,
    async (event, containerId: string): Promise<IpcResult<{ streamId: string }>> => {
      return createStreamHandler(
        'stats',
        () => dockerManager.containers.streamStats(containerId),
        (context, stream) => {
          wireJsonLineStream(context.sender, context.streamId, 'stats', stream);
        },
        event
      );
    }
  );
}

function registerEvents(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartEvents);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartEvents,
    async (event, options?: Docker.GetEventsOptions): Promise<IpcResult<{ streamId: string }>> => {
      return createStreamHandler(
        'events',
        () => dockerManager.system.streamEvents(options),
        (context, stream) => {
          wireJsonLineStream(context.sender, context.streamId, 'events', stream);
        },
        event
      );
    }
  );
}

function registerPull(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartPull);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartPull,
    async (event, image: string, options?: {}): Promise<IpcResult<{ streamId: string }>> => {
      return createProgressHandler(
        'pull',
        (abortSignal, onProgress) =>
          dockerManager.images.pullImageWithProgress(image, { ...(options ?? {}), abortSignal }, onProgress),
        event
      );
    }
  );
}

function registerPush(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.StartPush);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.StartPush,
    async (event, repoTag: string, options?: Docker.ImagePushOptions): Promise<IpcResult<{ streamId: string }>> => {
      return createProgressHandler(
        'push',
        (abortSignal, onProgress) =>
          dockerManager.images.pushImageWithProgress(repoTag, { ...(options ?? {}), abortSignal }, onProgress),
        event
      );
    }
  );
}

function registerStop(): void {
  ipcMain.removeHandler(IPC_CHANNELS.Docker.Streams.Stop);
  ipcMain.handle(
    IPC_CHANNELS.Docker.Streams.Stop,
    async (_event, streamId: string): Promise<IpcResult<{ stopped: boolean }>> => {
      return ok({ stopped: stopStreamSession(streamId) });
    }
  );
}
