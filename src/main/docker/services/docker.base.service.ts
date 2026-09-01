import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
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

  demuxStream(source: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void {
    this.client.modem.demuxStream(source, stdout, stderr);
  }

  async executeContainerCommand(
    containerId: string,
    command: string[],
    user?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const id = this.normalizeId(containerId, 'Container id');
    if (command.length === 0) throw new Error('Exec command is required.');

    const container = this.client.getContainer(id);
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: command,
      Tty: false,
      ...(user ? { User: user } : {})
    });
    const stream = await exec.start({ hijack: true, stdin: false, Tty: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let outputsFinished = false;

    const finishOutputs = (): void => {
      if (outputsFinished) return;
      outputsFinished = true;
      stdoutStream.end();
      stderrStream.end();
    };

    stream.on('end', finishOutputs);
    stream.on('close', finishOutputs);
    stream.on('error', error => {
      if (outputsFinished) return;
      outputsFinished = true;
      stdoutStream.destroy(error);
      stderrStream.destroy(error);
    });

    this.demuxStream(stream, stdoutStream, stderrStream);

    const [stdout, stderr] = await Promise.all([this.streamToText(stdoutStream), this.streamToText(stderrStream)]);
    const inspection = await exec.inspect();
    return { stdout, stderr, exitCode: inspection.ExitCode ?? -1 };
  }
}
