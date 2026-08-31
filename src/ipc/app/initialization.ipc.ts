import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { dockerManager } from '../../main/docker/services/docker.manager';

export function registerInitializationHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Initialization.RendererReady);
  ipcMain.on(IPC_CHANNELS.App.Initialization.RendererReady, () => {
    dockerManager.setRendererReady();
  });
}
