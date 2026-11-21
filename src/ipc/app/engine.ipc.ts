import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../channels';
import { fail, ok, type IpcResult } from '../contracts';
import { dockerManager } from '../../main/docker/services/docker.manager';
import { engineManager } from '../../main/docker/embedded/engine.manager';
import {
  CATBEE_CONTEXT_NAME,
  getDockerBuilderInfo,
  getDockerContextInfo,
  setupCatBeeContext,
  type DockerBuilderInfo,
  type DockerContextDetails
} from '../../main/docker/context/docker-context.manager';
import {
  getEngineSettings,
  mergeEngineSettings,
  resetEngineSettings,
  saveEngineSettings,
  type EngineSettings
} from '../../main/docker/embedded/engine-settings';
import { stopAllStreamSessions } from '../docker/streams.ipc';
import { logger } from '../../main/logger';

export function registerEngineHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Install);
  ipcMain.handle(IPC_CHANNELS.App.Engine.Install, async (): Promise<IpcResult<{ success: boolean }>> => {
    logger.info('[IPC] Received request to install embedded engine.');
    try {
      await dockerManager.installEmbeddedEngine();
      return ok({ success: true });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Start);
  ipcMain.handle(IPC_CHANNELS.App.Engine.Start, async (): Promise<IpcResult<{ success: boolean }>> => {
    logger.info('[IPC] Received request to start embedded engine.');
    try {
      await dockerManager.startEmbeddedEngine();
      return ok({ success: true });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Stop);
  ipcMain.handle(IPC_CHANNELS.App.Engine.Stop, async (): Promise<IpcResult<{ success: boolean }>> => {
    logger.info('[IPC] Received request to stop embedded engine.');
    try {
      await dockerManager.stopEmbeddedEngine();
      return ok({ success: true });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Restart);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.Restart,
    async (_event, mode?: 'auto' | 'embedded' | 'external'): Promise<IpcResult<{ success: boolean }>> => {
      logger.info(`[IPC] Received request to restart engine with mode: ${mode ?? 'configured'}`);
      try {
        if (mode) {
          await saveEngineSettings({ engineMode: mode });
        }
        await dockerManager.restartEmbeddedEngine(mode);
        return ok({ success: true });
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Pause);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.Pause,
    async (): Promise<IpcResult<{ pausedCount: number; isPaused: boolean }>> => {
      try {
        const res = await dockerManager.pauseEngine();
        return ok(res);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Resume);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.Resume,
    async (): Promise<IpcResult<{ resumedCount: number; isPaused: boolean }>> => {
      try {
        const res = await dockerManager.resumeEngine();
        return ok(res);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetPauseStatus);
  ipcMain.handle(IPC_CHANNELS.App.Engine.GetPauseStatus, (): IpcResult<{ isPaused: boolean; pausedCount: number }> => {
    return ok(dockerManager.getEnginePauseStatus());
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Status);
  ipcMain.handle(IPC_CHANNELS.App.Engine.Status, async (): Promise<IpcResult<unknown>> => {
    try {
      const isInstalled = await engineManager.isInstalled();
      const manifest = await engineManager.getManifest();
      const state = await engineManager.refreshStatus();
      const snapshot = engineManager.getSnapshot();
      return ok({
        isInstalled,
        state,
        manifest,
        runtime: dockerManager.currentRuntime,
        endpoint: snapshot.endpoint,
        exposedTcpEndpoint: snapshot.exposedTcpEndpoint,
        lastError: snapshot.lastError,
        operation: snapshot.operation,
        info: snapshot.info
      });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.CheckPrerequisites);
  ipcMain.handle(IPC_CHANNELS.App.Engine.CheckPrerequisites, async (): Promise<IpcResult<unknown>> => {
    try {
      const prereq = await engineManager.checkPrerequisites();
      return ok(prereq);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetContextInfo);
  ipcMain.handle(IPC_CHANNELS.App.Engine.GetContextInfo, async (): Promise<IpcResult<DockerContextDetails>> => {
    try {
      const info = await getDockerContextInfo();
      return ok(info);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.UseContext);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.UseContext,
    async (_event, contextName: string): Promise<IpcResult<DockerContextDetails>> => {
      if (!contextName || typeof contextName !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(contextName)) {
        return fail(new Error('Invalid Docker context name.'));
      }
      try {
        stopAllStreamSessions();
        const info = await dockerManager.switchContext(contextName);
        return ok(info);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.SetupCatBeeContext);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.SetupCatBeeContext,
    async (_event, setAsActive?: boolean, customEndpoint?: string): Promise<IpcResult<DockerContextDetails>> => {
      try {
        const info = await setupCatBeeContext(false, customEndpoint);
        if (setAsActive) {
          stopAllStreamSessions();
          const updated = await dockerManager.switchContext(CATBEE_CONTEXT_NAME);
          return ok(updated);
        }
        return ok(info);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetSettings);
  ipcMain.handle(IPC_CHANNELS.App.Engine.GetSettings, async (): Promise<IpcResult<EngineSettings>> => {
    try {
      const settings = await getEngineSettings();
      return ok(settings);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.SaveSettings);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.SaveSettings,
    async (_event, settings: Partial<EngineSettings>): Promise<IpcResult<EngineSettings>> => {
      try {
        const updated = await saveEngineSettings(settings);
        return ok(updated);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.ResetSettings);
  ipcMain.handle(IPC_CHANNELS.App.Engine.ResetSettings, async (): Promise<IpcResult<EngineSettings>> => {
    try {
      const reset = await resetEngineSettings();
      return ok(reset);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetWslDistros);
  ipcMain.handle(IPC_CHANNELS.App.Engine.GetWslDistros, async (): Promise<IpcResult<string[]>> => {
    try {
      const distros = await engineManager.getInstalledWslDistros();
      return ok(distros);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.ApplyWslDistroIntegration);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.ApplyWslDistroIntegration,
    async (_event, distroName: string, enabled: boolean): Promise<IpcResult<boolean>> => {
      if (!distroName || typeof distroName !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(distroName)) {
        return fail(new Error('Invalid WSL distribution name.'));
      }
      try {
        const success = await engineManager.configureWslDistroIntegration(distroName, enabled);
        return ok(success);
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.Uninstall);
  ipcMain.handle(IPC_CHANNELS.App.Engine.Uninstall, async (): Promise<IpcResult<{ success: boolean }>> => {
    logger.info('[IPC] Received request to uninstall the built-in engine.');
    try {
      stopAllStreamSessions();
      await dockerManager.uninstallEmbeddedEngine();
      return ok({ success: true });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.ApplySettings);
  ipcMain.handle(IPC_CHANNELS.App.Engine.ApplySettings, async (): Promise<IpcResult<{ applied: boolean }>> => {
    try {
      stopAllStreamSessions();
      return ok(await dockerManager.applyEngineSettings());
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetDaemonConfig);
  ipcMain.handle(
    IPC_CHANNELS.App.Engine.GetDaemonConfig,
    async (_event, draft?: Partial<EngineSettings>): Promise<IpcResult<Record<string, unknown>>> => {
      try {
        const saved = await getEngineSettings();
        const settings = draft ? mergeEngineSettings(saved, draft) : saved;
        return ok(await engineManager.getDaemonConfig(settings));
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Engine.GetBuilderInfo);
  ipcMain.handle(IPC_CHANNELS.App.Engine.GetBuilderInfo, async (): Promise<IpcResult<DockerBuilderInfo>> => {
    try {
      const info = await getDockerBuilderInfo();
      return ok(info);
    } catch (error) {
      return fail(error);
    }
  });
}
