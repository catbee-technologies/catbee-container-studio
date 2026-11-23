import { registerExternalHandlers } from './app/external.ipc';
import { registerWindowHandlers } from './app/window.ipc';
import { registerMenuHandlers } from './app/menu.ipc';
import { registerInitializationHandlers } from './app/initialization.ipc';
import { registerUpdaterHandlers } from './app/updater.ipc';
import { registerPlatformHandlers } from './app/platform.ipc';
import { registerDialogHandlers } from './app/dialog.ipc';
import { registerEngineHandlers } from './app/engine.ipc';
import { registerK8sHandlers } from './app/k8s.ipc';
import type { PrepareForUpdateInstall } from '../main/app/updater';

import { registerDockerSystemHandlers } from './docker/system.ipc';
import { registerDockerContainerHandlers } from './docker/containers.ipc';
import { registerDockerImageHandlers } from './docker/images.ipc';
import { registerDockerVolumeHandlers } from './docker/volumes.ipc';
import { registerDockerNetworkHandlers } from './docker/networks.ipc';
import { registerDockerStreamHandlers } from './docker/streams.ipc';
import { registerDockerExecSessionHandlers } from './docker/exec-session.ipc';

export function registerIpcHandlers(prepareForUpdateInstall: PrepareForUpdateInstall): void {
  // App
  registerExternalHandlers();
  registerWindowHandlers();
  registerMenuHandlers();
  registerInitializationHandlers();
  registerEngineHandlers();
  registerUpdaterHandlers(prepareForUpdateInstall);
  registerPlatformHandlers();
  registerDialogHandlers();
  registerK8sHandlers();

  // Docker
  registerDockerSystemHandlers();
  registerDockerContainerHandlers();
  registerDockerImageHandlers();
  registerDockerVolumeHandlers();
  registerDockerNetworkHandlers();
  registerDockerStreamHandlers();
  registerDockerExecSessionHandlers();
}
