import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { registerHandle } from '../utils/ipc.utils';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerDockerVolumeHandlers(): void {
  registerHandle(IPC_CHANNELS.Docker.Volumes.List, (options?: Docker.VolumeListOptions) =>
    dockerManager.volumes.listVolumes(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Inspect, (name: string) => dockerManager.volumes.inspectVolume(name));

  registerHandle(IPC_CHANNELS.Docker.Volumes.Create, (options: Docker.VolumeCreateOptions) =>
    dockerManager.volumes.createVolume(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Remove, (name: string, force?: boolean) =>
    dockerManager.volumes.removeVolume(name, force)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Prune, (filters?: { [key: string]: string[] }) =>
    dockerManager.system.pruneVolumes(filters)
  );
}
