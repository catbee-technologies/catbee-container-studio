import type Docker from 'dockerode';
import { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';
import { DockerBaseService } from './docker.base.service';
import {
  DockerActionResult,
  DockerContainerMount,
  DockerContainerNetwork,
  DockerContainerPort,
  DockerFileEntry,
  DockerFileType
} from '../types/docker.types';

export class DockerContainerService extends DockerBaseService {
  async listContainers(options?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    const containers = await this.client.listContainers({ all: true, ...(options ?? {}) });
    return containers.filter(container => !this.isKubernetesManagedContainer(container));
  }

  async inspectContainer(containerId: string): Promise<Docker.ContainerInspectInfo> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).inspect();
  }

  async createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.ContainerInspectInfo> {
    const container = await this.client.createContainer(options);
    return container.inspect();
  }

  async startContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).start();
    return { containerId: id, output: '' };
  }

  async stopContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).stop();
    return { containerId: id, output: '' };
  }

  async restartContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).restart();
    return { containerId: id, output: '' };
  }

  async pauseContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).pause();
    return { containerId: id, output: '' };
  }

  async unpauseContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).unpause();
    return { containerId: id, output: '' };
  }

  async killContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).kill();
    return { containerId: id, output: '' };
  }

  async removeContainer(containerId: string, force = false): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    await this.client.getContainer(id).remove({ force });
    return { containerId: id, output: '' };
  }

  async renameContainer(containerId: string, newName: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const name = this.normalizeId(newName, 'Container name');
    await this.client.getContainer(id).rename({ name });
    return { containerId: id, output: name };
  }

  async waitContainer(containerId: string, options?: Docker.ContainerWaitOptions): Promise<unknown> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).wait(options);
  }

  async logs(containerId: string, options?: Omit<Docker.ContainerLogsOptions, 'follow'>): Promise<string> {
    const id = this.normalizeId(containerId, 'Container id');
    const output = await this.client.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: true,
      ...(options ?? {}),
      follow: false
    });
    return this.decodeLogs(output as Buffer);
  }

  async streamLogs(
    containerId: string,
    options?: Omit<Docker.ContainerLogsOptions, 'follow'>
  ): Promise<NodeJS.ReadableStream> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: true,
      ...(options ?? {}),
      follow: true
    }) as Promise<NodeJS.ReadableStream>;
  }

  async stats(containerId: string): Promise<Docker.ContainerStats> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).stats({ stream: false });
  }

  async streamStats(containerId: string): Promise<NodeJS.ReadableStream> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).stats({ stream: true }) as Promise<NodeJS.ReadableStream>;
  }

  async top(containerId: string): Promise<unknown> {
    const id = this.normalizeId(containerId, 'Container id');
    return this.client.getContainer(id).top({});
  }

  async getContainerPorts(containerId: string): Promise<DockerContainerPort[]> {
    const container = await this.inspectContainer(containerId);
    const ports = container.NetworkSettings.Ports ?? {};
    return Object.entries(ports).map(([containerPort, hostBindings]) => ({
      containerPort,
      hostBindings: (hostBindings ?? []).map(binding => ({
        hostIp: binding.HostIp,
        hostPort: binding.HostPort
      }))
    }));
  }

  async getContainerEnv(containerId: string): Promise<string[]> {
    const container = await this.inspectContainer(containerId);
    return container.Config.Env ?? [];
  }

  async getContainerMounts(containerId: string): Promise<DockerContainerMount[]> {
    const container = await this.inspectContainer(containerId);
    return container.Mounts.map(mount => ({
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
      mode: mount.Mode,
      rw: mount.RW,
      propagation: mount.Propagation
    }));
  }

  async getContainerNetworks(containerId: string): Promise<DockerContainerNetwork[]> {
    const container = await this.inspectContainer(containerId);
    const networks = container.NetworkSettings.Networks ?? {};
    return Object.entries(networks).map(([name, network]) => ({
      name,
      networkId: network.NetworkID,
      endpointId: network.EndpointID,
      gateway: network.Gateway,
      ipAddress: network.IPAddress,
      ipPrefixLen: network.IPPrefixLen,
      macAddress: network.MacAddress,
      aliases: (network.Aliases as string[] | undefined) ?? []
    }));
  }

  async listContainerFiles(containerId: string, path = '/'): Promise<DockerFileEntry[]> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);

    const script = `
      if [ ! -d "$1" ]; then
        printf 'Directory does not exist or is not accessible: %s\n' "$1" >&2
        exit 1
      fi

      for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue

        name=$(basename "$entry")
        type="file"

        if [ -L "$entry" ]; then
          type="symlink"
        elif [ -d "$entry" ]; then
          type="directory"
        fi

        size=0
        modified=""
        mode=""

        if [ -f "$entry" ]; then
          size=$(stat -c '%s' "$entry" 2>/dev/null || stat -f '%z' "$entry" 2>/dev/null || printf '0')
        fi

        if [ -f "$entry" ] || [ -d "$entry" ]; then
          modified=$(stat -c '%Y' "$entry" 2>/dev/null || stat -f '%m' "$entry" 2>/dev/null || true)
          mode=$(stat -c '%a' "$entry" 2>/dev/null || stat -f '%Lp' "$entry" 2>/dev/null || true)
        fi

        printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$type" "$size" "$modified" "$mode"
      done
    `;

    const result = await this.executeContainerCommand(id, ['sh', '-c', script, '--', normalizedPath], '0');

    if (result.exitCode !== 0 || result.stderr.trim()) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Unable to list container directory.');
    }

    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => {
        const [name, type, size, modified, mode] = line.split('\t');

        const entryPath = normalizedPath === '/' ? `/${name}` : `${normalizedPath}/${name}`;

        return {
          name,
          path: entryPath,
          type: type as DockerFileType,
          size: Number.parseInt(size, 10) || 0,
          modifiedAt: modified ? new Date(Number.parseInt(modified, 10) * 1000).toISOString() : null,
          mode: mode || null
        };
      });
  }

  async readContainerFile(containerId: string, path: string): Promise<Buffer> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);
    const archive = await this.getContainerArchive(id, normalizedPath);
    return this.extractSingleFileFromTar(archive, normalizedPath);
  }

  async downloadContainerFile(containerId: string, path: string): Promise<Buffer> {
    return this.readContainerFile(containerId, path);
  }

  async uploadContainerFile(containerId: string, path: string, data: Buffer): Promise<void> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);

    const directory = this.getParentPath(normalizedPath);
    const fileName = this.getBaseName(normalizedPath);

    const metadata = await this.getContainerFileMetadata(id, normalizedPath);
    const archive = await this.createSingleFileTar(fileName, Buffer.from(data), metadata);

    const container = this.client.getContainer(id);

    await container.putArchive(archive, {
      path: directory
    });
  }

  async createContainerDirectory(containerId: string, path: string): Promise<void> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);

    const result = await this.executeContainerCommand(id, ['mkdir', '-p', '--', normalizedPath]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Unable to create directory.');
    }
  }

  async deleteContainerFile(containerId: string, path: string): Promise<void> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);

    if (normalizedPath === '/') {
      throw new Error('Cannot delete the container root directory.');
    }

    const result = await this.executeContainerCommand(id, ['rm', '-rf', '--', normalizedPath], '0');
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Unable to delete file.');
    }
  }

  async renameContainerFile(containerId: string, path: string, newPath: string): Promise<void> {
    const id = this.normalizeId(containerId, 'Container id');
    const normalizedPath = this.normalizeContainerPath(path);
    const normalizedNewPath = this.normalizeContainerPath(newPath);

    if (normalizedPath === '/') {
      throw new Error('Cannot rename the container root directory.');
    }

    if (normalizedNewPath === '/') {
      throw new Error('Cannot rename an item to the container root.');
    }

    const result = await this.executeContainerCommand(id, ['mv', '--', normalizedPath, normalizedNewPath]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Unable to rename file.');
    }
  }

  async writeContainerFile(containerId: string, path: string, data: Buffer): Promise<void> {
    return this.uploadContainerFile(containerId, path, data);
  }

  private extractSingleFileFromTar(archive: Buffer, requestedPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const extractor = extract();

      let found = false;
      const chunks: Buffer[] = [];
      const requestedName = this.getBaseName(requestedPath);

      extractor.on('entry', (header, stream, next) => {
        const entryName = header.name.replace(/^\.\//, '').replace(/\/$/, '');

        if (
          !found &&
          header.type === 'file' &&
          entryName &&
          entryName !== '.' &&
          this.getBaseName(entryName) === requestedName
        ) {
          found = true;

          stream.on('data', (chunk: unknown) => {
            if (Buffer.isBuffer(chunk)) {
              chunks.push(chunk);
            } else if (typeof chunk === 'string') {
              chunks.push(Buffer.from(chunk));
            }
          });

          stream.on('error', reject);

          stream.on('end', () => {
            next();
          });

          return;
        }

        stream.resume();
        stream.on('end', next);
      });

      extractor.on('finish', () => {
        if (!found) {
          reject(new Error(`File not found in container archive: ${requestedPath}`));
          return;
        }

        resolve(Buffer.concat(chunks));
      });

      extractor.on('error', reject);

      Readable.from(archive).pipe(extractor);
    });
  }

  private getParentPath(path: string): string {
    const normalized = this.normalizeContainerPath(path);

    if (normalized === '/') {
      return '/';
    }

    const index = normalized.lastIndexOf('/');

    if (index <= 0) {
      return '/';
    }

    return normalized.slice(0, index);
  }

  private getBaseName(path: string): string {
    const normalized = this.normalizeContainerPath(path);

    if (normalized === '/') {
      throw new Error('Container root does not have a file name.');
    }

    const index = normalized.lastIndexOf('/');

    return normalized.slice(index + 1);
  }

  private createSingleFileTar(
    fileName: string,
    data: Buffer,
    metadata?: { uid: number; gid: number; mode: number }
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const archive = pack();
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
        }
      });

      archive.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      archive.on('error', reject);

      archive.entry(
        {
          name: fileName,
          size: data.length,
          type: 'file',
          ...(metadata ?? {})
        },
        data
      );

      archive.finalize();
    });
  }

  private async getContainerFileMetadata(
    containerId: string,
    path: string
  ): Promise<{ uid: number; gid: number; mode: number } | undefined> {
    const script = `stat -c '%u\t%g\t%a' "$1" 2>/dev/null || stat -f '%u\t%g\t%Lp' "$1" 2>/dev/null`;
    const result = await this.executeContainerCommand(containerId, ['sh', '-c', script, '--', path], '0');
    if (result.exitCode !== 0) {
      return undefined;
    }

    const [uid, gid, mode] = result.stdout.trim().split('\t');
    const parsedUid = Number.parseInt(uid, 10);
    const parsedGid = Number.parseInt(gid, 10);
    const parsedMode = Number.parseInt(mode, 8);
    if (![parsedUid, parsedGid, parsedMode].every(Number.isFinite)) {
      return undefined;
    }

    return { uid: parsedUid, gid: parsedGid, mode: parsedMode };
  }

  private async getContainerArchive(containerId: string, path: string): Promise<Buffer> {
    const container = this.client.getContainer(containerId);
    const stream = await container.getArchive({ path });
    return this.streamToBuffer(stream);
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
        }
      });

      stream.on('error', reject);

      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  private normalizeContainerPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
      return '/';
    }

    const raw = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const stack: string[] = [];

    for (const part of raw.split('/')) {
      if (!part || part === '.') {
        continue;
      }
      if (part === '..') {
        stack.pop();
        continue;
      }
      stack.push(part);
    }

    return stack.length === 0 ? '/' : `/${stack.join('/')}`;
  }
}
