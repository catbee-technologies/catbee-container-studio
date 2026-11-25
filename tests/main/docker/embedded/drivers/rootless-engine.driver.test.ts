import { readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootlessEngineDriver } from '../../../../../src/main/docker/embedded/drivers/rootless-engine.driver';
import {
  getEngineBinDir,
  getEngineRootDir,
  getLinuxRuntimeDir
} from '../../../../../src/main/docker/embedded/engine-paths';
import { pingDockerEndpoint, updateEngineManifest } from '../../../../../src/main/docker/embedded/engine-utils';

vi.mock('electron', () => ({}));
vi.mock('../../../../../src/main/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), readlink: vi.fn(), rm: vi.fn() }));
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  pingDockerEndpoint: vi.fn(),
  updateEngineManifest: vi.fn(),
  sleep: vi.fn()
}));

describe('Linux rootless shutdown', () => {
  const pid = 12345;
  let processExists: boolean;

  beforeEach(() => {
    vi.resetAllMocks();
    processExists = true;
    vi.mocked(readFile).mockImplementation(async filename => {
      const file = String(filename);
      if (file.endsWith('/stat')) {
        if (!processExists) throw new Error('process exited');
        const fields = ['S', '1', String(pid), ...Array<string>(16).fill('0'), '100'];
        return [`${pid} (rootless launcher)`, ...fields].join(' ');
      }
      if (file.endsWith('/cmdline')) {
        return [
          'docker-rootlesskit',
          path.join(getEngineBinDir(), 'dockerd-rootless.sh'),
          `--state-dir=${path.join(getLinuxRuntimeDir(), 'dockerd-rootless')}`,
          `--data-root=${path.join(getEngineRootDir(), 'data')}`
        ].join('\0');
      }
      return String(pid);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('signals the verified process group even when the launcher is outside CatBee’s bin directory', async () => {
    vi.mocked(readlink).mockResolvedValue('/usr/bin/docker-rootlesskit');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      processExists = false;
      return true;
    });

    await new RootlessEngineDriver().stop();

    expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, 'SIGTERM');
    expect(updateEngineManifest).toHaveBeenCalledWith({ state: 'stopped' });
  });

  it('never signals a reused PID or cleans up a socket that still responds', async () => {
    vi.mocked(readlink).mockResolvedValue('/usr/bin/unrelated');
    vi.mocked(pingDockerEndpoint).mockResolvedValue(true);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    await expect(new RootlessEngineDriver().stop()).rejects.toThrow('without a verified CatBee launcher');
    expect(kill).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(updateEngineManifest).not.toHaveBeenCalled();
  });
});
