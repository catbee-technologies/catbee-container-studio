import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import {
  DockerActionResult,
  DockerContainerMount,
  DockerContainerNetwork,
  DockerContainerPort,
  DockerProgressEvent,
  DockerSystemPruneSummary
} from './docker.types';
import { DockerRuntimeManager } from './docker.runtime-manager';
import { DockerInitializationStatus } from './docker.runtime';

export class DockerService {
  private client!: Docker;
  private readonly runtimeManager = new DockerRuntimeManager();

  private rendererReady = false;
  private latestStatus: DockerInitializationStatus | null = null;
  private statusListener?: (status: DockerInitializationStatus) => void;

  async initialize(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void
  ): Promise<void> {
    this.statusListener = onStatus;

    this.emitStatus({
      state: 'checking',
      message: 'Checking Docker availability...',
      hint: 'Verifying if Docker Engine is running and accessible.'
    });

    this.client = await this.runtimeManager.ensureDockerAvailable(status => this.emitStatus(status), onRuntimeStarted);

    this.emitStatus({
      state: 'ready',
      message: 'Docker Engine is ready.',
      hint: 'Docker Engine is running and accessible.'
    });
  }

  setRendererReady(): void {
    this.rendererReady = true;
    if (this.latestStatus) {
      this.statusListener?.(this.latestStatus);
    }
  }

  private emitStatus(status: DockerInitializationStatus): void {
    this.latestStatus = status;
    if (this.rendererReady) {
      this.statusListener?.(status);
    }
  }

  private normalizeId(value: string, label: string): string {
    const normalized = value.trim();

    if (!normalized) {
      throw new Error(`${label} is required.`);
    }

    return normalized;
  }

  private streamToText(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      stream.on('error', reject);
      stream.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }

  private async streamToJsonLines(stream: NodeJS.ReadableStream): Promise<unknown[]> {
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

  private followProgress(stream: NodeJS.ReadableStream): Promise<DockerProgressEvent[]> {
    return new Promise((resolve, reject) => {
      this.client.modem.followProgress(stream, (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        const events = (result ?? []) as DockerProgressEvent[];
        resolve(events);
      });
    });
  }

  private followProgressWithUpdates(
    stream: NodeJS.ReadableStream,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    return new Promise((resolve, reject) => {
      this.client.modem.followProgress(
        stream,
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          const events = (result ?? []) as DockerProgressEvent[];
          resolve(events);
        },
        event => {
          onProgress(event as DockerProgressEvent);
        }
      );
    });
  }

  demuxStream(source: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void {
    this.client.modem.demuxStream(source, stdout, stderr);
  }

  private decodeLogs(buffer: Buffer): string {
    return buffer.toString('utf8');
  }

  private isKubernetesManagedContainer(container: Docker.ContainerInfo): boolean {
    const labels = container.Labels ?? {};
    const names = container.Names ?? [];

    return (
      'io.kubernetes.container.name' in labels ||
      'io.kubernetes.pod.name' in labels ||
      'io.kubernetes.pod.namespace' in labels ||
      names.some(name => name.startsWith('/k8s_'))
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<unknown> {
    return this.client.info();
  }

  async version(): Promise<Docker.DockerVersion> {
    return this.client.version();
  }

  async diskUsage(): Promise<unknown> {
    return this.client.df();
  }

  async events(options?: Docker.GetEventsOptions): Promise<unknown[]> {
    const stream = await this.client.getEvents({
      ...(options ?? {}),
      until: options?.until ?? Math.floor(Date.now() / 1000)
    });

    return this.streamToJsonLines(stream);
  }

  async pruneContainers(): Promise<Docker.PruneContainersInfo> {
    return this.client.pruneContainers({});
  }

  async pruneImages(filters?: Record<string, string[]>): Promise<Docker.PruneImagesInfo> {
    return this.client.pruneImages(filters ? { filters } : {});
  }

  async pruneVolumes(filters?: Docker.VolumePruneOptions['filters']): Promise<Docker.PruneVolumesInfo> {
    return this.client.pruneVolumes(filters ? { filters } : {});
  }

  async pruneNetworks(): Promise<Docker.PruneNetworksInfo> {
    return this.client.pruneNetworks({});
  }

  async pruneBuildCache(): Promise<Docker.PruneBuilderInfo> {
    return this.client.pruneBuilder({});
  }

  async pruneSystem(): Promise<DockerSystemPruneSummary> {
    const [containers, images, volumes, networks, buildCache] = await Promise.all([
      this.pruneContainers(),
      this.pruneImages(),
      this.pruneVolumes(),
      this.pruneNetworks(),
      this.pruneBuildCache()
    ]);

    return {
      containers,
      images,
      volumes,
      networks,
      buildCache
    };
  }

  async listContainers(options?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    const containers = await this.client.listContainers({
      all: true,
      ...(options ?? {})
    });

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
    const container = this.client.getContainer(id);

    await container.start();

    return {
      containerId: id,
      output: ''
    };
  }

  async stopContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.stop();

    return {
      containerId: id,
      output: ''
    };
  }

  async restartContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.restart();

    return {
      containerId: id,
      output: ''
    };
  }

  async pauseContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.pause();

    return {
      containerId: id,
      output: ''
    };
  }

  async unpauseContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.unpause();

    return {
      containerId: id,
      output: ''
    };
  }

  async killContainer(containerId: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.kill();

    return {
      containerId: id,
      output: ''
    };
  }

  async removeContainer(containerId: string, force = false): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);

    await container.remove({ force });

    return {
      containerId: id,
      output: ''
    };
  }

  async renameContainer(containerId: string, newName: string): Promise<DockerActionResult> {
    const id = this.normalizeId(containerId, 'Container id');
    const name = this.normalizeId(newName, 'Container name');
    const container = this.client.getContainer(id);

    await container.rename({ name });

    return {
      containerId: id,
      output: name
    };
  }

  async waitContainer(containerId: string, options?: Docker.ContainerWaitOptions): Promise<unknown> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);
    return container.wait(options);
  }

  async logs(containerId: string, options?: Omit<Docker.ContainerLogsOptions, 'follow'>): Promise<string> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);
    const output = await container.logs({
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
    const container = this.client.getContainer(id);
    return container.logs({
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
    const container = this.client.getContainer(id);
    return container.stats({ stream: false });
  }

  async streamStats(containerId: string): Promise<NodeJS.ReadableStream> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);
    return container.stats({ stream: true }) as Promise<NodeJS.ReadableStream>;
  }

  async top(containerId: string): Promise<unknown> {
    const id = this.normalizeId(containerId, 'Container id');
    const container = this.client.getContainer(id);
    return container.top({});
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

  async listImages(options?: Docker.ListImagesOptions): Promise<Docker.ImageInfo[]> {
    return this.client.listImages(options ?? {});
  }

  async inspectImage(imageId: string): Promise<Docker.ImageInspectInfo> {
    const id = this.normalizeId(imageId, 'Image id');
    return this.client.getImage(id).inspect();
  }

  async pullImage(image: string, options?: {}): Promise<DockerProgressEvent[]> {
    const repoTag = this.normalizeId(image, 'Image');
    const stream = await this.client.pull(repoTag, options ?? {});
    return this.followProgress(stream);
  }

  async pullImageWithProgress(
    image: string,
    options: { abortSignal?: AbortSignal } | undefined,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    const repoTag = this.normalizeId(image, 'Image');
    const stream = await this.client.pull(repoTag, options ?? {});
    return this.followProgressWithUpdates(stream, onProgress);
  }

  async pushImage(repoTag: string, options?: Docker.ImagePushOptions): Promise<DockerProgressEvent[]> {
    const image = this.normalizeId(repoTag, 'Image');
    const stream = await this.client.getImage(image).push(options ?? {});
    return this.followProgress(stream);
  }

  async pushImageWithProgress(
    repoTag: string,
    options: (Docker.ImagePushOptions & { abortSignal?: AbortSignal }) | undefined,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    const image = this.normalizeId(repoTag, 'Image');
    const stream = await this.client.getImage(image).push(options ?? {});
    return this.followProgressWithUpdates(stream, onProgress);
  }

  async tagImage(imageId: string, repo: string, tag: string): Promise<void> {
    const id = this.normalizeId(imageId, 'Image id');
    const repository = this.normalizeId(repo, 'Repository');
    const nextTag = this.normalizeId(tag, 'Tag');
    await this.client.getImage(id).tag({ repo: repository, tag: nextTag });
  }

  async removeImage(imageId: string, force = false, pruneChildren = false): Promise<Docker.ImageRemoveInfo[]> {
    const id = this.normalizeId(imageId, 'Image id');
    const response = await this.client.getImage(id).remove({
      force,
      noprune: !pruneChildren
    });

    return (Array.isArray(response) ? response : [response]) as Docker.ImageRemoveInfo[];
  }

  async historyImage(imageId: string): Promise<Docker.Image[]> {
    const id = this.normalizeId(imageId, 'Image id');
    return this.client.getImage(id).history();
  }

  async listVolumes(options?: Docker.VolumeListOptions): Promise<{
    Volumes: Docker.VolumeInspectInfo[];
    Warnings: string[];
  }> {
    return this.client.listVolumes(options ?? {});
  }

  async inspectVolume(name: string): Promise<Docker.VolumeInspectInfo> {
    const volumeName = this.normalizeId(name, 'Volume name');
    return this.client.getVolume(volumeName).inspect();
  }

  async createVolume(options: Docker.VolumeCreateOptions): Promise<Docker.VolumeCreateResponse> {
    return this.client.createVolume(options);
  }

  async removeVolume(name: string, force = false): Promise<void> {
    const volumeName = this.normalizeId(name, 'Volume name');
    await this.client.getVolume(volumeName).remove({ force });
  }

  async listNetworks(options?: Docker.NetworkListOptions): Promise<Docker.NetworkInspectInfo[]> {
    return this.client.listNetworks(options ?? {});
  }

  async inspectNetwork(networkId: string): Promise<Docker.NetworkInspectInfo> {
    const id = this.normalizeId(networkId, 'Network id');
    return this.client.getNetwork(id).inspect();
  }

  async createNetwork(options: Docker.NetworkCreateOptions): Promise<Docker.NetworkInspectInfo> {
    const network = await this.client.createNetwork(options);
    return this.client.getNetwork(network.id).inspect();
  }

  async removeNetwork(networkId: string): Promise<void> {
    const id = this.normalizeId(networkId, 'Network id');
    await this.client.getNetwork(id).remove();
  }

  async connectNetwork(networkId: string, containerId: string): Promise<void> {
    const network = this.normalizeId(networkId, 'Network id');
    const container = this.normalizeId(containerId, 'Container id');
    await this.client.getNetwork(network).connect({
      Container: container
    });
  }

  async disconnectNetwork(networkId: string, containerId: string, force = false): Promise<void> {
    const network = this.normalizeId(networkId, 'Network id');
    const container = this.normalizeId(containerId, 'Container id');
    await this.client.getNetwork(network).disconnect({
      Container: container,
      Force: force
    });
  }

  async runExec(containerId: string, command: string[]): Promise<{ stdout: string; stderr: string }> {
    const id = this.normalizeId(containerId, 'Container id');

    if (command.length === 0) {
      throw new Error('Exec command is required.');
    }

    const container = this.client.getContainer(id);
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: command,
      Tty: false
    });

    const stream = await exec.start({
      hijack: true,
      stdin: false,
      Tty: false
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    this.client.modem.demuxStream(stream, stdoutStream, stderrStream);

    const [stdout, stderr] = await Promise.all([this.streamToText(stdoutStream), this.streamToText(stderrStream)]);

    return {
      stdout,
      stderr
    };
  }

  async createExecSession(
    containerId: string,
    command: string[],
    tty = true
  ): Promise<{ execId: string; stream: NodeJS.ReadWriteStream }> {
    const id = this.normalizeId(containerId, 'Container id');

    if (command.length === 0) {
      throw new Error('Exec command is required.');
    }

    const container = this.client.getContainer(id);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: command,
      Tty: tty
    });

    const stream = await exec.start({
      hijack: true,
      stdin: true,
      Tty: tty
    });

    return {
      execId: exec.id,
      stream
    };
  }

  async resizeExecSession(execId: string, cols: number, rows: number): Promise<void> {
    const id = this.normalizeId(execId, 'Exec id');
    await this.client.getExec(id).resize({
      w: cols,
      h: rows
    });
  }

  async streamEvents(options?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream> {
    return this.client.getEvents(options ?? {});
  }
}
