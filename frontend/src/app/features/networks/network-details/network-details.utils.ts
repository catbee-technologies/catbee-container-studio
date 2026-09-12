import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerNetworkInfo } from '@shared/types/docker-api.types';
import { containerInfoFromInspect, fallbackContainerFromEndpoint } from '@utils/docker-container.utils';

export async function resolveConnectedContainers(
  dockerApi: DockerApiService,
  network: DockerNetworkInfo | null,
  containers: DockerContainerInfo[]
): Promise<DockerContainerInfo[]> {
  if (!network) {
    return [];
  }

  const attachedEntries = Object.entries(network.Containers ?? {});
  if (attachedEntries.length === 0) {
    return [];
  }

  const attachedIds = attachedEntries.map(([id]) => id);

  const matchedContainers = containers.filter(container =>
    attachedIds.some(id => id === container.Id || id.startsWith(container.Id) || container.Id.startsWith(id))
  );

  const missingEntries = attachedEntries.filter(
    ([id]) => !matchedContainers.some(c => c.Id === id || id.startsWith(c.Id) || c.Id.startsWith(id))
  );

  if (missingEntries.length === 0) {
    return matchedContainers;
  }

  const inspectResults = await Promise.allSettled(
    missingEntries.map(async ([id, endpoint]) => {
      try {
        const inspect = await dockerApi.inspectContainer(id);
        return containerInfoFromInspect(inspect, id, endpoint?.Name);
      } catch {
        return fallbackContainerFromEndpoint(id, endpoint);
      }
    })
  );

  const extraContainers: DockerContainerInfo[] = inspectResults.map((result, idx) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const [id, endpoint] = missingEntries[idx];
    return fallbackContainerFromEndpoint(id, endpoint);
  });

  return [...matchedContainers, ...extraContainers];
}
