import { contextBridge, ipcRenderer } from 'electron';

/**
 * Keep IPC channel definitions local to the sandboxed preload.
 * Sandboxed preload scripts cannot reliably load local CommonJS modules
 * when compiled with plain TypeScript (tsc), so importing from ipc/channels.ts
 * would cause the preload script to fail at runtime.
 */
const IPC_CHANNELS = {
  Docker: {
    ListContainers: 'docker:list-containers',
    StartContainer: 'docker:start-container',
    StopContainer: 'docker:stop-container'
  }
} as const;

type DockerBridge = {
  listContainers: () => Promise<unknown>;
  startContainer: (containerId: string) => Promise<unknown>;
  stopContainer: (containerId: string) => Promise<unknown>;
};

type ElectronBridge = {
  docker: DockerBridge;
};

const electronBridge: ElectronBridge = {
  docker: {
    listContainers: () => ipcRenderer.invoke(IPC_CHANNELS.Docker.ListContainers),

    startContainer: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.StartContainer, containerId),

    stopContainer: (containerId: string) => ipcRenderer.invoke(IPC_CHANNELS.Docker.StopContainer, containerId)
  }
};

contextBridge.exposeInMainWorld('electron', electronBridge);
