import type Docker from 'dockerode';
import { DockerProgressEvent } from '../types/docker.types';

export class DockerBaseService {
  constructor(protected readonly client: Docker) {}

  protected normalizeId(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`${label} is required.`);
    }
    return normalized;
  }

  protected streamToText(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  protected async streamToJsonLines(stream: NodeJS.ReadableStream): Promise<unknown[]> {
    const text = await this.streamToText(stream);
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  }

  protected followProgress(stream: NodeJS.ReadableStream): Promise<DockerProgressEvent[]> {
    return new Promise((resolve, reject) => {
      this.client.modem.followProgress(stream, (error, result) => {
        if (error) return reject(error);
        resolve((result ?? []) as DockerProgressEvent[]);
      });
    });
  }

  protected followProgressWithUpdates(
    stream: NodeJS.ReadableStream,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    return new Promise((resolve, reject) => {
      this.client.modem.followProgress(
        stream,
        (error, result) => {
          if (error) return reject(error);
          resolve((result ?? []) as DockerProgressEvent[]);
        },
        event => onProgress(event as DockerProgressEvent)
      );
    });
  }

  demuxStream(source: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void {
    this.client.modem.demuxStream(source, stdout, stderr);
  }

  protected decodeLogs(buffer: Buffer): string {
    return buffer.toString('utf8');
  }

  protected isKubernetesManagedContainer(container: Docker.ContainerInfo): boolean {
    const labels = container.Labels ?? {};
    const names = container.Names ?? [];

    return (
      'io.kubernetes.container.name' in labels ||
      'io.kubernetes.pod.name' in labels ||
      'io.kubernetes.pod.namespace' in labels ||
      names.some(name => name.startsWith('/k8s_'))
    );
  }
}
