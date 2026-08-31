import type Docker from 'dockerode';
import { IPC_CHANNELS } from '../channels';
import { registerHandle } from '../utils/ipc.utils';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerDockerNetworkHandlers(): void {
  registerHandle(IPC_CHANNELS.Docker.Networks.List, (options?: Docker.NetworkListOptions) =>
    dockerManager.networks.listNetworks(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Inspect, (networkId: string) =>
    dockerManager.networks.inspectNetwork(networkId)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Create, (options: Docker.NetworkCreateOptions) =>
    dockerManager.networks.createNetwork(options)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Remove, (networkId: string) =>
    dockerManager.networks.removeNetwork(networkId)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Connect, (networkId: string, containerId: string) =>
    dockerManager.networks.connectNetwork(networkId, containerId)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Disconnect, (networkId: string, containerId: string, force?: boolean) =>
    dockerManager.networks.disconnectNetwork(networkId, containerId, force)
  );

  registerHandle(IPC_CHANNELS.Docker.Networks.Prune, () => dockerManager.system.pruneNetworks());
}
