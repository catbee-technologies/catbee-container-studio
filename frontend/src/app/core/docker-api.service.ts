import { Injectable } from '@angular/core';
import {
  DockerActionResult,
  DockerContainerInfo,
  DockerExecSessionCreateResult,
  DockerImageInfo,
  DockerStreamEventEnvelope,
  DockerVolumeInfo,
  IpcResult,
  StreamStartResult
} from '@shared/types/docker-api.types';
import { ElectronBridge } from '@shared/types/electron.types';

type GenericRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GenericRecord {
  return typeof value === 'object' && value !== null;
}

function isIpcResult<T>(value: unknown): value is IpcResult<T> {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value['ok'] === 'boolean';
}

function isStreamEventEnvelope(value: unknown): value is DockerStreamEventEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value['streamId'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['type'] === 'string' &&
    typeof value['timestamp'] === 'string'
  );
}

@Injectable({ providedIn: 'root' })
export class DockerApiService {
  private static readonly DEFAULT_LOG_TAIL_LINES = 1000;

  private get bridge(): ElectronBridge {
    const maybeBridge = (globalThis as unknown as { electron?: ElectronBridge }).electron;

    if (!maybeBridge) {
      throw new Error('Electron bridge is unavailable. Ensure preload is loaded.');
    }

    return maybeBridge;
  }

  private unwrapResult<T>(payload: unknown): T {
    if (!isIpcResult<T>(payload)) {
      throw new Error('Invalid IPC response payload.');
    }

    const result = payload;

    if (result.ok === false) {
      throw new Error(result.error.message);
    }

    return result.data;
  }

  async listContainers(): Promise<DockerContainerInfo[]> {
    const response = await this.bridge.docker.containers.list({ all: true });
    return this.unwrapResult<DockerContainerInfo[]>(response);
  }

  async listImages(): Promise<DockerImageInfo[]> {
    const response = await this.bridge.docker.images.list();
    return this.unwrapResult<DockerImageInfo[]>(response);
  }

  async inspectImage(imageId: string): Promise<unknown> {
    const response = await this.bridge.docker.images.inspect(imageId);
    return this.unwrapResult<unknown>(response);
  }

  async removeImage(imageId: string, force = false): Promise<void> {
    const response = await this.bridge.docker.images.remove(imageId, force, false);
    this.unwrapResult<unknown>(response);
  }

  async pruneImages(): Promise<void> {
    const response = await this.bridge.docker.images.prune();
    this.unwrapResult<unknown>(response);
  }

  async listVolumes(): Promise<DockerVolumeInfo[]> {
    const response = await this.bridge.docker.volumes.list();
    const data = this.unwrapResult<{ Volumes?: DockerVolumeInfo[] }>(response);
    return data.Volumes ?? [];
  }

  async inspectVolume(name: string): Promise<unknown> {
    const response = await this.bridge.docker.volumes.inspect(name);
    return this.unwrapResult<unknown>(response);
  }

  async removeVolume(name: string, force = false): Promise<void> {
    const response = await this.bridge.docker.volumes.remove(name, force);
    this.unwrapResult<unknown>(response);
  }

  async pruneVolumes(): Promise<void> {
    const response = await this.bridge.docker.volumes.prune();
    this.unwrapResult<unknown>(response);
  }

  showItemInFolder(path: string): void {
    void this.bridge.app.shell.showItem(path);
  }

  async inspectContainer(containerId: string): Promise<unknown> {
    const response = await this.bridge.docker.containers.inspect(containerId);
    return this.unwrapResult<unknown>(response);
  }

  async startContainer(containerId: string): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.start(containerId);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async stopContainer(containerId: string): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.stop(containerId);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async restartContainer(containerId: string): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.restart(containerId);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async pauseContainer(containerId: string): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.pause(containerId);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async unpauseContainer(containerId: string): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.unpause(containerId);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async runExec(containerId: string, command: string[]): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.exec(containerId, command);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async removeContainer(containerId: string, force = false): Promise<DockerActionResult> {
    const response = await this.bridge.docker.containers.remove(containerId, force);
    return this.unwrapResult<DockerActionResult>(response);
  }

  async getContainerStats(containerId: string): Promise<unknown> {
    const response = await this.bridge.docker.containers.stats(containerId);
    return this.unwrapResult<unknown>(response);
  }

  async startLogsStream(
    containerId: string,
    since?: number,
    tailLines = DockerApiService.DEFAULT_LOG_TAIL_LINES
  ): Promise<StreamStartResult> {
    const response = await this.bridge.docker.streams.startLogs(containerId, {
      tail: tailLines,
      timestamps: false,
      stdout: true,
      stderr: true,
      ...(since ? { since } : {})
    });

    return this.unwrapResult<StreamStartResult>(response);
  }

  async startStatsStream(containerId: string): Promise<StreamStartResult> {
    const response = await this.bridge.docker.streams.startStats(containerId);
    return this.unwrapResult<StreamStartResult>(response);
  }

  async startEventsStream(): Promise<StreamStartResult> {
    const response = await this.bridge.docker.streams.startEvents();
    return this.unwrapResult<StreamStartResult>(response);
  }

  async stopStream(streamId: string): Promise<boolean> {
    const response = await this.bridge.docker.streams.stop(streamId);
    const data = this.unwrapResult<{ stopped: boolean }>(response);
    return data.stopped;
  }

  async openExternalUrl(url: string): Promise<boolean> {
    const response = await this.bridge.app.external.open(url);
    const data = this.unwrapResult<{ opened: boolean }>(response);
    return data.opened;
  }

  onStreamEvent(callback: (event: DockerStreamEventEnvelope) => void): () => void {
    return this.bridge.docker.streams.onEvent((payload: unknown) => {
      if (!isStreamEventEnvelope(payload)) {
        return;
      }

      callback(payload);
    });
  }

  async createExecSession(containerId: string, command: string[], tty = true): Promise<DockerExecSessionCreateResult> {
    const response = await this.bridge.docker.execSession.create(containerId, command, tty);
    return this.unwrapResult<DockerExecSessionCreateResult>(response);
  }

  async writeExecSession(sessionId: string, data: string): Promise<boolean> {
    const response = await this.bridge.docker.execSession.write(sessionId, data);
    const dataResult = this.unwrapResult<{ written: boolean }>(response);
    return dataResult.written;
  }

  async resizeExecSession(sessionId: string, cols: number, rows: number): Promise<boolean> {
    const response = await this.bridge.docker.execSession.resize(sessionId, cols, rows);
    const data = this.unwrapResult<{ resized: boolean }>(response);
    return data.resized;
  }

  async closeExecSession(sessionId: string): Promise<boolean> {
    const response = await this.bridge.docker.execSession.close(sessionId);
    const data = this.unwrapResult<{ closed: boolean }>(response);
    return data.closed;
  }
}
