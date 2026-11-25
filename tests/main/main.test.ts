import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';
import { registerIpcHandlers } from '../../src/ipc';
import { stopAllStreamSessions } from '../../src/ipc/docker/streams.ipc';
import { dockerManager } from '../../src/main/docker/services/docker.manager';

vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), {
    commandLine: { appendSwitch: vi.fn() },
    getVersion: () => '0.6.0',
    requestSingleInstanceLock: () => true,
    whenReady: async () => {}
  }),
  protocol: { registerSchemesAsPrivileged: vi.fn() }
}));
vi.mock('electron-updater', () => ({
  autoUpdater: Object.assign(new EventEmitter(), { quitAndInstall: vi.fn() })
}));
vi.mock('../../src/ipc', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../src/ipc/docker/streams.ipc', () => ({ stopAllStreamSessions: vi.fn() }));
vi.mock('../../src/main/app/constants', () => ({ isDev: false, isMacOS: false }));
vi.mock('../../src/main/app/menu', () => ({ buildApplicationMenu: vi.fn() }));
vi.mock('../../src/main/app/protocol', () => ({ registerAppProtocol: vi.fn() }));
vi.mock('../../src/main/docker/embedded/engine.manager', () => ({ engineManager: { onOperationProgress: vi.fn() } }));
vi.mock('../../src/main/docker/services/docker.manager', () => ({
  dockerManager: { shutdown: vi.fn(), initialize: vi.fn(async () => {}) }
}));
vi.mock('../../src/main/k8s/k8s-manager.js', () => ({ k8sManager: { onProgress: vi.fn() } }));
vi.mock('../../src/main/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/main/window', () => ({
  createMainWindow: () =>
    Object.assign(new EventEmitter(), {
      maximize: vi.fn(),
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { send: vi.fn() })
    })
}));

afterEach(() => vi.useRealTimers());

it('blocks NSIS after the main-process shutdown deadline and retries after shutdown completes', async () => {
  vi.useFakeTimers();
  const shutdown = Promise.withResolvers<void>();
  vi.mocked(dockerManager.shutdown).mockReturnValue(shutdown.promise);
  await import('../../src/main/main.js');
  const [[prepare]] = vi.mocked(registerIpcHandlers).mock.calls;
  const { restartAndInstallUpdate } = await import('../../src/main/app/updater.js');
  autoUpdater.emit('update-downloaded', { version: '0.7.0', files: [], releaseDate: '', downloadedFile: 'update.exe' });

  const timedOut = restartAndInstallUpdate(prepare);
  await vi.advanceTimersByTimeAsync(30_000);
  await timedOut;
  expect(stopAllStreamSessions).toHaveBeenCalledOnce();
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

  const retry = restartAndInstallUpdate(prepare);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  shutdown.resolve();
  await retry;
  expect(dockerManager.shutdown).toHaveBeenCalledOnce();
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
});
