import { app, ipcMain, shell } from 'electron';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../channels';
import { fail, ok } from '../contracts';
import { APP_VERSION, LOG_DIR_PATH } from '../../main/app/constants';
import { getEngineRootDir } from '../../main/docker/embedded/engine-paths';

const LINUX_AUTOSTART_FILE = 'catbee-container-studio.desktop';

function linuxAutostartPath(): string {
  // eslint-disable-next-line n/no-process-env
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', LINUX_AUTOSTART_FILE);
}

function getStartAtLogin(): boolean {
  if (process.platform === 'linux') {
    return existsSync(linuxAutostartPath());
  }
  return app.getLoginItemSettings().openAtLogin;
}

async function setStartAtLogin(enabled: boolean): Promise<void> {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const file = linuxAutostartPath();
  if (!enabled) {
    await rm(file, { force: true });
    return;
  }
  // AppImage builds run from a temporary mount; APPIMAGE points at the real file.
  // eslint-disable-next-line n/no-process-env
  const executable = process.env.APPIMAGE ?? process.execPath;
  const escapedExec = executable
    .replaceAll('\\', '\\\\')
    .replaceAll('"', String.raw`\"`)
    .replaceAll('`', String.raw`\``)
    .replaceAll('$', String.raw`\$`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${app.getName()}`,
      `Exec="${escapedExec}"`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      ''
    ].join('\n'),
    'utf8'
  );
}

/** Free space (GiB) on the volume holding `dir`, which is where the built-in engine stores its disk. */
async function freeDiskGb(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Math.floor((stats.bavail * stats.bsize) / 1024 ** 3);
  } catch {
    return null;
  }
}

export function registerPlatformHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.Get);
  ipcMain.handle(IPC_CHANNELS.App.Platform.Get, () => ok(process.platform));

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.GetInfo);
  ipcMain.handle(IPC_CHANNELS.App.Platform.GetInfo, async () =>
    ok({
      platform: process.platform,
      arch: process.arch,
      appVersion: APP_VERSION,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      osRelease: os.release(),
      osType: os.type(),
      totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      cpuCount: os.cpus().length,
      freeDiskGb: await freeDiskGb(os.homedir())
    })
  );

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.OpenLogs);
  ipcMain.handle(IPC_CHANNELS.App.Platform.OpenLogs, async () => {
    await shell.openPath(LOG_DIR_PATH);
    return ok({ opened: true });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.OpenEngineDir);
  ipcMain.handle(IPC_CHANNELS.App.Platform.OpenEngineDir, async () => {
    const engineDir = getEngineRootDir();
    await mkdir(engineDir, { recursive: true });
    const error = await shell.openPath(engineDir);
    return error ? fail(new Error(error)) : ok({ opened: true, path: engineDir });
  });

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.GetStartAtLogin);
  ipcMain.handle(IPC_CHANNELS.App.Platform.GetStartAtLogin, () => ok(getStartAtLogin()));

  ipcMain.removeHandler(IPC_CHANNELS.App.Platform.SetStartAtLogin);
  ipcMain.handle(IPC_CHANNELS.App.Platform.SetStartAtLogin, async (_event, enabled: boolean) => {
    try {
      await setStartAtLogin(Boolean(enabled));
      return ok(getStartAtLogin());
    } catch (error) {
      return fail(error);
    }
  });
}
