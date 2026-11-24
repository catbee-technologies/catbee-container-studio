import { DockerBaseService } from './docker.base.service';

export class DockerExecService extends DockerBaseService {
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

  async resizeExecSession(execId: string, cols: number, rows: number): Promise<boolean> {
    const id = this.normalizeId(execId, 'Exec id');
    try {
      await this.client.getExec(id).resize({ w: cols, h: rows });
      return true;
    } catch (error) {
      const notStartedMessage = 'exec process is not started';
      if (error instanceof Error && error.message.includes(notStartedMessage)) {
        return false;
      }
      throw error;
    }
  }
}
