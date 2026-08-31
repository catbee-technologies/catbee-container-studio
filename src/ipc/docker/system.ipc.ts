import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { registerHandle } from '../utils/ipc.utils';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerDockerSystemHandlers(): void {
  registerHandle(IPC_CHANNELS.Docker.Engine.Ping, () => dockerManager.system.ping());

  registerHandle(IPC_CHANNELS.Docker.Engine.Info, () => dockerManager.system.info());

  registerHandle(IPC_CHANNELS.Docker.Engine.Version, () => dockerManager.system.version());

  registerHandle(IPC_CHANNELS.Docker.Engine.DiskUsage, () => dockerManager.system.diskUsage());

  registerHandle(IPC_CHANNELS.Docker.Engine.Events, (options?: Docker.GetEventsOptions) =>
    dockerManager.system.events(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Engine.PruneSystem, () => dockerManager.system.pruneSystem());

  registerHandle(IPC_CHANNELS.Docker.System.PruneContainers, () => dockerManager.system.pruneContainers());

  registerHandle(IPC_CHANNELS.Docker.System.PruneImages, (filters?: { [key: string]: string[] }) =>
    dockerManager.system.pruneImages(filters)
  );

  registerHandle(IPC_CHANNELS.Docker.System.PruneVolumes, (filters?: { [key: string]: string[] }) =>
    dockerManager.system.pruneVolumes(filters)
  );

  registerHandle(IPC_CHANNELS.Docker.System.PruneNetworks, () => dockerManager.system.pruneNetworks());

  registerHandle(IPC_CHANNELS.Docker.System.PruneBuildCache, () => dockerManager.system.pruneBuildCache());
}
