import { ipcMain, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../channels';
import { ok } from '../contracts';
import { APP_VERSION, LOG_DIR_PATH } from '../../main/app/constants';

export function registerPlatformHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.Get);
  ipcMain.handle(IPC_CHANNELS.App.Platform.Get, () => ok(process.platform));

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.GetInfo);
  ipcMain.handle(IPC_CHANNELS.App.Platform.GetInfo, () =>
    ok({
      platform: process.platform,
      arch: process.arch,
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      osRelease: os.release(),
      osType: os.type(),
      totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      cpuCount: os.cpus().length
    })
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.OpenLogs);
  ipcMain.handle(IPC_CHANNELS.App.Platform.OpenLogs, async () => {
    await shell.openPath(LOG_DIR_PATH);
    return ok({ opened: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.OpenEngineDir);
  ipcMain.handle(IPC_CHANNELS.App.Platform.OpenEngineDir, async () => {
    let engineDir: string;
    if (process.platform === 'win32') {
      // eslint-disable-next-line n/no-process-env
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      engineDir = path.join(localAppData, 'CatBee', 'engine');
    } else if (process.platform === 'darwin') {
      engineDir = path.join(os.homedir(), 'Library', 'Application Support', 'CatBee', 'engine');
    } else {
      engineDir = path.join(os.homedir(), '.local', 'share', 'catbee', 'engine');
    }
    await shell.openPath(engineDir);
    return ok({ opened: true, path: engineDir });
  });
}
