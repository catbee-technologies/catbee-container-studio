import type Docker from 'dockerode';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';
import { logger } from '../../logger';
import { getDockerCliPath } from '../runtime/docker.runtime';
import { DockerBaseService } from './docker.base.service';
import {
  DockerActionResult,
  DockerContainerMount,
  DockerContainerNetwork,
  DockerContainerPort,
  DockerFileEntry,
  DockerFileType
} from '../types/docker.types';

const execFileAsync = promisify(execFile);

export class DockerContainerService extends DockerBaseService {
  async listContainers(options?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    const containers = await this.client.listContainers({ all: true, ...(options ?? {}) });
    return containers;
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

  async recreateComposeGroup(options: {
    workingDir: string;
    configFiles?: string[];
    projectName?: string;
    service?: string;
    services?: string[];
  }): Promise<DockerActionResult> {
    const workingDir = options.workingDir;
    if (!workingDir) {
      throw new Error('Cannot recreate compose group: working directory is not specified.');
    }

    try {
      await access(workingDir);
    } catch {
      throw new Error(
        `Cannot recreate compose group: working directory "${workingDir}" does not exist on this machine.`
      );
    }

    const dockerCli = (await getDockerCliPath()) || 'docker';

    const composeArgs = ['compose'];

    if (options.projectName) {
      composeArgs.push('-p', options.projectName);
    }

    if (options.configFiles && options.configFiles.length > 0) {
      for (const file of options.configFiles) {
        if (file && file.trim()) {
          composeArgs.push('-f', file.trim());
        }
      }
    }

    composeArgs.push('up', '-d', '--force-recreate');

    if (options.services && options.services.length > 0) {
      for (const svc of options.services) {
        if (svc && svc.trim()) {
          composeArgs.push(svc.trim());
        }
      }
    } else if (options.service) {
      composeArgs.push(options.service);
    }

    logger.debug(
      `[DockerContainerService] Running compose recreate: ${dockerCli} ${composeArgs.join(' ')} (cwd: ${workingDir})`
    );

    let stdout = '';
    let stderr = '';
    try {
      const res = await execFileAsync(dockerCli, composeArgs, {
        cwd: workingDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err: unknown) {
      const errorStr = String(err);
      if (errorStr.includes('is not a docker command') || errorStr.includes('unknown command: docker compose')) {
        logger.warn('[DockerContainerService] "docker compose" failed. Trying "docker-compose" fallback.');
        const standaloneArgs = composeArgs.slice(1);
        try {
          const res = await execFileAsync('docker-compose', standaloneArgs, {
            cwd: workingDir,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024
          });
          stdout = res.stdout;
          stderr = res.stderr;
        } catch (fallbackErr: unknown) {
          const e = fallbackErr as { stderr?: string; stdout?: string; message?: string };
          throw new Error(e.stderr || e.stdout || e.message || 'Docker Compose recreate failed.');
        }
      } else {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        throw new Error(e.stderr || e.stdout || e.message || 'Docker Compose recreate failed.');
      }
    }

    logger.debug(`[DockerContainerService] Docker compose recreate completed: ${stdout || stderr}`);

    if (options.service && options.projectName) {
      try {
        const containers = await this.client.listContainers({
          all: true,
          filters: {
            label: [
              `com.docker.compose.project=${options.projectName}`,
              `com.docker.compose.service=${options.service}`
            ]
          }
        });
        if (containers.length > 0 && containers[0].Id) {
          return { containerId: containers[0].Id, output: stdout || stderr };
        }
      } catch {
        // Fall back to returning empty containerId
      }
    }

    return { containerId: '', output: stdout || stderr };
  }

  async recreateContainer(containerId: string, options?: { env?: string[] }): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const inspectInfo = await this.client.getContainer(id).inspect();

    const composeProject = inspectInfo.Config?.Labels?.['com.docker.compose.project'];
    const composeService = inspectInfo.Config?.Labels?.['com.docker.compose.service'];
    const composeWorkingDir = inspectInfo.Config?.Labels?.['com.docker.compose.project.working_dir'];
    const composeConfigFiles = inspectInfo.Config?.Labels?.['com.docker.compose.project.config_files']
      ?.split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // If container belongs to a Compose project, working directory exists on host,
    // and no custom env overrides are specified, use Compose recreate.
    // When custom env is passed, recreate via Engine API to apply the updated environment variables.
    let canUseCompose = false;
    if (!options?.env && composeWorkingDir && composeService) {
      try {
        await access(composeWorkingDir);
        canUseCompose = true;
      } catch {
        logger.debug(
          `[DockerContainerService] Compose working dir "${composeWorkingDir}" not accessible on host. Falling back to Engine API recreate.`
        );
      }
    }

    if (canUseCompose && composeWorkingDir && composeService) {
      return await this.recreateComposeGroup({
        workingDir: composeWorkingDir,
        configFiles: composeConfigFiles,
        projectName: composeProject,
        service: composeService
      });
    }

    // Standalone container or compose working directory not found on host: recreate via Docker Engine API
    const wasRunning = inspectInfo.State?.Running ?? false;
    const name = inspectInfo.Name ? inspectInfo.Name.replace(/^\//, '') : undefined;
    const config = inspectInfo.Config ?? {};
    const configRecord = config as unknown as Record<string, unknown>;
    const stopSignal = typeof configRecord['StopSignal'] === 'string' ? configRecord['StopSignal'] : undefined;
    const stopTimeout = typeof configRecord['StopTimeout'] === 'number' ? configRecord['StopTimeout'] : undefined;
    const hostConfig = inspectInfo.HostConfig ?? {};
    const networkSettings = inspectInfo.NetworkSettings;

    const createOptions: Docker.ContainerCreateOptions = {
      name,
      Image: config.Image || inspectInfo.Image,
      Env: options?.env !== undefined ? options.env : config.Env || undefined,
      Cmd: config.Cmd || undefined,
      Entrypoint: config.Entrypoint || undefined,
      WorkingDir: config.WorkingDir || undefined,
      User: config.User || undefined,
      Labels: config.Labels || undefined,
      ExposedPorts: config.ExposedPorts || undefined,
      Volumes: config.Volumes || undefined,
      StopSignal: stopSignal,
      StopTimeout: stopTimeout,
      Tty: config.Tty,
      OpenStdin: config.OpenStdin,
      StdinOnce: config.StdinOnce,
      AttachStdin: config.AttachStdin,
      AttachStdout: config.AttachStdout,
      AttachStderr: config.AttachStderr,
      HostConfig: hostConfig
    };

    const oldContainer = this.client.getContainer(id);
    const tempName = name ? `${name}-catbee-old-${Date.now()}` : undefined;

    if (wasRunning) {
      await oldContainer.stop({ t: 10 }).catch(() => {});
    }

    if (tempName) {
      await oldContainer.rename({ name: tempName });
    }

    let newContainer: Docker.Container;
    try {
      newContainer = await this.client.createContainer(createOptions);
    } catch (createErr) {
      // Revert name and restart old container if creation failed
      if (tempName && name) {
        await oldContainer.rename({ name }).catch(() => {});
        if (wasRunning) {
          await oldContainer.start().catch(() => {});
        }
      }
      throw createErr;
    }

    // Safe removal of old container
    await oldContainer.remove({ force: true, v: false }).catch(err => {
      logger.warn({ err }, '[DockerContainerService] Failed to remove old container after recreate');
    });

    // Reconnect additional networks if any
    if (networkSettings?.Networks) {
      const networks = Object.entries(networkSettings.Networks);
      for (const [netName, endpointSettings] of networks) {
        try {
          const net = this.client.getNetwork(netName);
          await net.connect({
            Container: newContainer.id,
            EndpointConfig: {
              Aliases: endpointSettings?.Aliases,
              IPAMConfig: endpointSettings?.IPAMConfig,
              Links: endpointSettings?.Links
            }
          });
        } catch {
          // May already be connected to the primary network
        }
      }
    }

    if (wasRunning) {
      await newContainer.start();
    }

    return { containerId: newContainer.id, output: '' };
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
