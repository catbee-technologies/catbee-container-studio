import { ipcMain } from 'electron';
import { DockerService } from '../main/docker/docker.service';
import { IPC_CHANNELS } from './channels';

const dockerService = new DockerService();

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.Docker.ListContainers, async () => {
    return dockerService.listContainers();
  });

  ipcMain.handle(IPC_CHANNELS.Docker.StartContainer, async (_event, containerId: string) => {
    return dockerService.startContainer(containerId);
  });

  ipcMain.handle(IPC_CHANNELS.Docker.StopContainer, async (_event, containerId: string) => {
    return dockerService.stopContainer(containerId);
  });
}
