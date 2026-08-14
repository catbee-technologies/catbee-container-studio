import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerInfo, DockerVolumeInfo } from '@shared/types/docker-api.types';

export interface VolumeDetailsPrefetch {
  volume: DockerVolumeInfo | null;
  containersInUse: DockerContainerInfo[];
  error: string | null;
}

export const volumeDetailsResolver: ResolveFn<VolumeDetailsPrefetch> = async route => {
  const volumeName = (route.paramMap.get('name') ?? '').trim();
  if (!volumeName) {
    return {
      volume: null,
      containersInUse: [],
      error: 'Volume name is required.'
    };
  }

  const dockerApi = inject(DockerApiService);

  try {
    const [volume, containers] = await Promise.all([dockerApi.inspectVolume(volumeName), dockerApi.listContainers()]);
    const inUse: DockerContainerInfo[] = [];
    const inspectResults = await Promise.allSettled(
      containers.map(container => dockerApi.inspectContainer(container.Id))
    );

    for (let idx = 0; idx < inspectResults.length; idx += 1) {
      const result = inspectResults[idx];
      if (!result || result.status !== 'fulfilled') {
        continue;
      }

      const payload = result.value as { Mounts?: { Type?: unknown; Name?: unknown }[] };
      const mounts = payload.Mounts;
      if (!Array.isArray(mounts)) {
        continue;
      }

      const isUsingVolume = mounts.some(mount => mount.Type === 'volume' && mount.Name === volumeName);
      if (isUsingVolume) {
        const container = containers[idx];
        if (container) {
          inUse.push(container);
        }
      }
    }

    return {
      volume: volume as DockerVolumeInfo,
      containersInUse: inUse,
      error: null
    };
  } catch (error) {
    return {
      volume: null,
      containersInUse: [],
      error: error instanceof Error ? error.message : 'Failed to preload volume details.'
    };
  }
};
