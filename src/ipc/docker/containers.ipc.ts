import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { registerHandle } from '../utils/ipc.utils';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerDockerContainerHandlers(): void {
  registerHandle(IPC_CHANNELS.Docker.Containers.List, (options?: Docker.ContainerListOptions) =>
    dockerManager.containers.listContainers(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Inspect, (containerId: string) =>
    dockerManager.containers.inspectContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Create, (options: Docker.ContainerCreateOptions) =>
    dockerManager.containers.createContainer(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Start, (containerId: string) =>
    dockerManager.containers.startContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Stop, (containerId: string) =>
    dockerManager.containers.stopContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Restart, (containerId: string) =>
    dockerManager.containers.restartContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Pause, (containerId: string) =>
    dockerManager.containers.pauseContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Unpause, (containerId: string) =>
    dockerManager.containers.unpauseContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Kill, (containerId: string) =>
    dockerManager.containers.killContainer(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Remove, (containerId: string, force?: boolean) =>
    dockerManager.containers.removeContainer(containerId, force)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Rename, (containerId: string, newName: string) =>
    dockerManager.containers.renameContainer(containerId, newName)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Wait, (containerId: string, options?: Docker.ContainerWaitOptions) =>
    dockerManager.containers.waitContainer(containerId, options)
  );

  registerHandle(
    IPC_CHANNELS.Docker.Containers.Logs,
    (containerId: string, options?: Omit<Docker.ContainerLogsOptions, 'follow'>) =>
      dockerManager.containers.logs(containerId, options)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Stats, (containerId: string) =>
    dockerManager.containers.stats(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Top, (containerId: string) =>
    dockerManager.containers.top(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Exec, (containerId: string, command: string[]) =>
    dockerManager.exec.runExec(containerId, command)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Ports, (containerId: string) =>
    dockerManager.containers.getContainerPorts(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Env, (containerId: string) =>
    dockerManager.containers.getContainerEnv(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Mounts, (containerId: string) =>
    dockerManager.containers.getContainerMounts(containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Containers.Networks, (containerId: string) =>
    dockerManager.containers.getContainerNetworks(containerId)
  );
}
