import type { DockerStreamEventEnvelope } from '../../contracts';
import { IPC_CHANNELS } from '../../channels';

export function emitStreamEvent<T>(webContents: Electron.WebContents, payload: DockerStreamEventEnvelope<T>): void {
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(IPC_CHANNELS.Docker.Streams.Event, payload);
}

export function buildStreamEvent<T>(
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

export function tryDestroyStream(stream: NodeJS.ReadableStream | NodeJS.ReadWriteStream): void {
  const destroyable = stream as {
    destroy?: () => void;
  };
  destroyable.destroy?.();
}

export function tryEndStream(stream: NodeJS.ReadWriteStream): void {
  const endable = stream as {
    end?: () => void;
  };
  endable.end?.();
}

export function wireTextStream(
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

export function wireJsonLineStream(
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
      emitJsonLine(webContents, streamId, kind, line);
    }
  });

  stream.on('end', () => {
    emitJsonLine(webContents, streamId, kind, pending);
  });
}

function emitJsonLine(
  webContents: Electron.WebContents,
  streamId: string,
  kind: DockerStreamEventEnvelope['kind'],
  line: string
): void {
  const normalized = line.trim();

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
}
