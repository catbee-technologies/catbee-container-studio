import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerNetworkInfo } from '@shared/types/docker-api.types';

export interface NetworkDetailsPrefetch {
  network: DockerNetworkInfo | null;
  connectedContainers: DockerContainerInfo[];
  error: string | null;
}

export const networkDetailsResolver: ResolveFn<NetworkDetailsPrefetch> = async route => {
  const networkId = (route.paramMap.get('id') ?? '').trim();
  if (!networkId) {
    return { network: null, connectedContainers: [], error: 'Network id is required.' };
  }

  const dockerApi = inject(DockerApiService);
  try {
    const [network, containers] = await Promise.all([dockerApi.inspectNetwork(networkId), dockerApi.listContainers()]);
    const attachedIds = Object.keys(network.Containers ?? {});
    const connectedContainers = containers.filter(container =>
      attachedIds.some(attachedId => attachedId === container.Id || attachedId.startsWith(container.Id))
    );
    return { network, connectedContainers, error: null };
  } catch (error) {
    return {
      network: null,
      connectedContainers: [],
      error: error instanceof Error ? error.message : 'Failed to preload network details.'
    };
  }
};
