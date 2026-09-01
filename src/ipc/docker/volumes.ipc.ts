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

  registerHandle(IPC_CHANNELS.Docker.Volumes.Files.List, (name: string, path?: string) =>
    dockerManager.volumes.listVolumeFiles(name, path)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Files.Read, (name: string, path: string) =>
    dockerManager.volumes.readVolumeFile(name, path)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Files.Write, (name: string, path: string, data: Buffer) =>
    dockerManager.volumes.writeVolumeFile(name, path, data)
  );

  registerHandle(IPC_CHANNELS.Docker.Volumes.Files.Delete, (name: string, path: string) =>
    dockerManager.volumes.deleteVolumeFile(name, path)
  );
}
