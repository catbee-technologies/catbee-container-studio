import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { fail, ok, type IpcResult } from '../contracts';
import { k8sManager, type K8sClusterInfo, type K8sStartResult } from '../../main/k8s/k8s-manager';
import { logger } from '../../main/logger';
import { saveEngineSettings, type KubernetesSettingsConfig } from '../../main/docker/embedded/engine-settings';

export function registerK8sHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.GetStatus);
  ipcMain.handle(IPC_CHANNELS.App.K8s.GetStatus, async (): Promise<IpcResult<K8sClusterInfo>> => {
    try {
      const status = await k8sManager.getStatus();
      return ok(status);
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to get Kubernetes status.');
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.GetProgress);
  ipcMain.handle(IPC_CHANNELS.App.K8s.GetProgress, (): IpcResult<unknown> => {
    try {
      const progress = k8sManager.getCurrentProgress();
      return ok(progress);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.ResetCluster);
  ipcMain.handle(
    IPC_CHANNELS.App.K8s.ResetCluster,
    async (_event, config?: KubernetesSettingsConfig): Promise<IpcResult<K8sStartResult>> => {
      try {
        const saved = config ? await saveEngineSettings({ kubernetes: config }) : undefined;
        const result = await k8sManager.resetCluster();
        return ok({ ...result, settings: saved?.kubernetes });
      } catch (error) {
        logger.error({ err: error }, '[IPC] Failed to reset Kubernetes cluster.');
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.GetVersions);
  ipcMain.handle(IPC_CHANNELS.App.K8s.GetVersions, async (): Promise<IpcResult<string[]>> => {
    try {
      const versions = await k8sManager.getAvailableVersions();
      return ok(versions);
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to get Kubernetes versions.');
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.StartCluster);
  ipcMain.handle(
    IPC_CHANNELS.App.K8s.StartCluster,
    async (_event, config?: KubernetesSettingsConfig): Promise<IpcResult<K8sStartResult>> => {
      try {
        const saved = config ? await saveEngineSettings({ kubernetes: config }) : undefined;
        return ok({ ...(await k8sManager.startCluster(saved?.kubernetes)), settings: saved?.kubernetes });
      } catch (error) {
        logger.error({ err: error }, '[IPC] Failed to start Kubernetes cluster.');
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.StopCluster);
  ipcMain.handle(IPC_CHANNELS.App.K8s.StopCluster, async (): Promise<IpcResult<{ success: boolean }>> => {
    try {
      await k8sManager.stopCluster();
      return ok({ success: true });
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to stop Kubernetes cluster.');
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.InstallRuntime);
  ipcMain.handle(IPC_CHANNELS.App.K8s.InstallRuntime, async (): Promise<IpcResult<{ success: boolean }>> => {
    try {
      await k8sManager.installKind();
      return ok({ success: true });
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to install Kubernetes runtime.');
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.UninstallRuntime);
  ipcMain.handle(IPC_CHANNELS.App.K8s.UninstallRuntime, async (): Promise<IpcResult<{ success: boolean }>> => {
    try {
      const result = await k8sManager.uninstallRuntime();
      return ok(result);
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to uninstall Kubernetes runtime.');
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.K8s.CancelOperation);
  ipcMain.handle(IPC_CHANNELS.App.K8s.CancelOperation, async (): Promise<IpcResult<{ success: boolean }>> => {
    try {
      const result = await k8sManager.cancelCurrentOperation();
      return ok(result);
    } catch (error) {
      logger.error({ err: error }, '[IPC] Failed to cancel Kubernetes operation.');
      return fail(error);
    }
  });
}
