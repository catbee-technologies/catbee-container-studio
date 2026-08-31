import { PassThrough } from 'node:stream';
import { DockerBaseService } from './docker.base.service';

export class DockerExecService extends DockerBaseService {
  async runExec(containerId: string, command: string[]): Promise<{ stdout: string; stderr: string }> {
    const id = this.normalizeId(containerId, 'Container id');
    if (command.length === 0) throw new Error('Exec command is required.');

    const container = this.client.getContainer(id);
    const exec = await container.exec({ AttachStdout: true, AttachStderr: true, Cmd: command, Tty: false });
    const stream = await exec.start({ hijack: true, stdin: false, Tty: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    this.demuxStream(stream, stdoutStream, stderrStream);

    const [stdout, stderr] = await Promise.all([this.streamToText(stdoutStream), this.streamToText(stderrStream)]);
    return { stdout, stderr };
  }

  async createExecSession(
    containerId: string,
    command: string[],
    tty = true
  ): Promise<{ execId: string; stream: NodeJS.ReadWriteStream }> {
    const id = this.normalizeId(containerId, 'Container id');
    if (command.length === 0) throw new Error('Exec command is required.');

    const container = this.client.getContainer(id);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: command,
      Tty: tty
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });

    return { execId: exec.id, stream };
  }

  async resizeExecSession(execId: string, cols: number, rows: number): Promise<void> {
    const id = this.normalizeId(execId, 'Exec id');
    await this.client.getExec(id).resize({ w: cols, h: rows });
  }
}
