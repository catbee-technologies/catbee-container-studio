import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { IpcResult, fail, ok } from '../contracts';
import { dockerManager } from '../../main/docker/services/docker.manager';
import {
  emitStreamEvent,
  buildStreamEvent,
  wireTextStream,
  tryDestroyStream,
  tryEndStream
} from './utils/stream.utils';

type ExecSession = {
  ownerWebContentsId: number;
  execId: string;
  stream: NodeJS.ReadWriteStream;
  stop: () => void;
};

const execSessions = new Map<string, ExecSession>();

function stopExecSession(sessionId: string): boolean {
  const session = execSessions.get(sessionId);
  if (!session) {
    return false;
  }
  session.stop();
  execSessions.delete(sessionId);
  return true;
}

export function registerDockerExecSessionHandlers(): void {
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

        const { execId, stream } = await dockerManager.exec.createExecSession(containerId, command, tty);

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

        return ok({ sessionId, execId });
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
      return ok({ written: true });
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
      await dockerManager.exec.resizeExecSession(session.execId, cols, rows);
      return ok({ resized: true });
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.Docker.ExecSession.Close);
  ipcMain.handle(
    IPC_CHANNELS.Docker.ExecSession.Close,
    async (_event, sessionId: string): Promise<IpcResult<{ closed: boolean }>> => {
      return ok({ closed: stopExecSession(sessionId) });
    }
  );
}
