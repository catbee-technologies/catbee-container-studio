import type Docker from 'dockerode';
import { DockerBaseService } from './docker.base.service';
import {
  DockerActionResult,
  DockerContainerMount,
  DockerContainerNetwork,
  DockerContainerPort
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
}
