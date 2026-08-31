import type Docker from 'dockerode';
import { DockerBaseService } from './docker.base.service';
import { DockerSystemPruneSummary } from '../types/docker.types';

export class DockerSystemService extends DockerBaseService {
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

  async streamEvents(options?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream> {
    return this.client.getEvents(options ?? {});
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

    return { containers, images, volumes, networks, buildCache };
  }
}
