import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerImageHistoryInfo, DockerImageInspectInfo } from '@shared/types/docker-api.types';

export interface ImageDetailsPrefetch {
  inspectData: DockerImageInspectInfo | null;
  inUseByContainers: DockerContainerInfo[];
  history: DockerImageHistoryInfo[];
  error: string | null;
}

export const imageDetailsResolver: ResolveFn<ImageDetailsPrefetch> = async route => {
  const imageId = (route.paramMap.get('id') ?? '').trim();
  if (!imageId) {
    return {
      inspectData: null,
      history: [],
      inUseByContainers: [],
      error: 'Image id is required.'
    };
  }

  const dockerApi = inject(DockerApiService);

  try {
    const [inspectData, containers, history] = await Promise.all([
      dockerApi.inspectImage(imageId),
      dockerApi.listContainers(),
      dockerApi.historyImage(imageId)
    ]);
    const inUse: DockerContainerInfo[] = [];

    const inspectResults = await Promise.allSettled(
      containers.map(container => dockerApi.inspectContainer(container.Id))
    );

    for (let idx = 0; idx < inspectResults.length; idx += 1) {
      const result = inspectResults[idx];
      if (!result || result.status !== 'fulfilled') {
        continue;
      }

      const payload = result.value;
      const inspectImage = payload.ImageID ?? payload.Image;
      if (typeof inspectImage === 'string' && inspectImage === imageId) {
        const container = containers[idx];
        if (container) {
          inUse.push(container);
        }
      }
    }

    return {
      inspectData,
      inUseByContainers: inUse,
      history: history.reverse(), // Reverse the history to show the most recent layers first
      error: null
    };
  } catch (error) {
    return {
      inspectData: null,
      inUseByContainers: [],
      history: [],
      error: error instanceof Error ? error.message : 'Failed to preload image details.'
    };
  }
};
