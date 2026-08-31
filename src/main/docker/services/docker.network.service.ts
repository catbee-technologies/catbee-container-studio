import type Docker from 'dockerode';
import { DockerBaseService } from './docker.base.service';

export class DockerNetworkService extends DockerBaseService {
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
    await this.client.getNetwork(network).connect({ Container: container });
  }

  async disconnectNetwork(networkId: string, containerId: string, force = false): Promise<void> {
    const network = this.normalizeId(networkId, 'Network id');
    const container = this.normalizeId(containerId, 'Container id');
    await this.client.getNetwork(network).disconnect({ Container: container, Force: force });
  }
}
