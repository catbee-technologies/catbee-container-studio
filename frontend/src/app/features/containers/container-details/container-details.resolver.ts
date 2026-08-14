import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo } from '@shared/types/docker-api.types';

export interface ContainerDetailsPrefetch {
  container: DockerContainerInfo | null;
  inspectData: unknown | null;
  error: string | null;
}

export const containerDetailsResolver: ResolveFn<ContainerDetailsPrefetch> = async route => {
  const containerId = (route.paramMap.get('id') ?? '').trim();
  if (!containerId) {
    return {
      container: null,
      inspectData: null,
      error: 'Container id is required.'
    };
  }

  const dockerApi = inject(DockerApiService);

  try {
    const [containers, inspectData] = await Promise.all([
      dockerApi.listContainers(),
      dockerApi.inspectContainer(containerId)
    ]);

    const container = containers.find(item => item.Id === containerId) ?? null;
    if (!container) {
      return {
        container: null,
        inspectData: null,
        error: 'Container not found. It may have been removed.'
      };
    }

    return {
      container,
      inspectData,
      error: null
    };
  } catch (error) {
    return {
      container: null,
      inspectData: null,
      error: error instanceof Error ? error.message : 'Failed to preload container details.'
    };
  }
};
