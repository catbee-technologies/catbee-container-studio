import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo } from '@shared/types/docker-api.types';

export interface ImageDetailsPrefetch {
  inspectData: unknown | null;
  inUseByContainers: DockerContainerInfo[];
  error: string | null;
}

export const imageDetailsResolver: ResolveFn<ImageDetailsPrefetch> = async route => {
  const imageId = (route.paramMap.get('id') ?? '').trim();
  if (!imageId) {
    return {
      inspectData: null,
      inUseByContainers: [],
      error: 'Image id is required.'
    };
  }

  const dockerApi = inject(DockerApiService);

  try {
    const [inspectData, containers] = await Promise.all([dockerApi.inspectImage(imageId), dockerApi.listContainers()]);
    const inUse: DockerContainerInfo[] = [];

    const inspectResults = await Promise.allSettled(
      containers.map(container => dockerApi.inspectContainer(container.Id))
    );

    for (let idx = 0; idx < inspectResults.length; idx += 1) {
      const result = inspectResults[idx];
      if (!result || result.status !== 'fulfilled') {
        continue;
      }

      const payload = result.value as { Image?: unknown };
      if (typeof payload.Image === 'string' && payload.Image === imageId) {
        const container = containers[idx];
        if (container) {
          inUse.push(container);
        }
      }
    }

    return {
      inspectData,
      inUseByContainers: inUse,
      error: null
    };
  } catch (error) {
    return {
      inspectData: null,
      inUseByContainers: [],
      error: error instanceof Error ? error.message : 'Failed to preload image details.'
    };
  }
};
