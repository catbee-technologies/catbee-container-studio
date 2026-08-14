export interface IpcErrorPayload {
  message: string;
  code?: string;
  details?: unknown;
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export interface IpcFailure {
  ok: false;
  error: IpcErrorPayload;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export type DockerStreamKind = 'logs' | 'stats' | 'events' | 'pull' | 'push' | 'exec';
export type DockerStreamEventType = 'data' | 'error' | 'end';
export type DockerLogChannel = 'stdout' | 'stderr';

export interface DockerStreamEventEnvelope<T = unknown> {
  streamId: string;
  kind: DockerStreamKind;
  type: DockerStreamEventType;
  timestamp: string;
  channel?: DockerLogChannel;
  data?: T;
  error?: string;
}

export function ok<T>(data: T): IpcResult<T> {
  return {
    ok: true,
    data
  };
}

export function fail(error: unknown): IpcFailure {
  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        message: error.message,
        details: {
          name: error.name,
          stack: error.stack
        }
      }
    };
  }

  return {
    ok: false,
    error: {
      message: 'Unknown IPC error.',
      details: error
    }
  };
}
