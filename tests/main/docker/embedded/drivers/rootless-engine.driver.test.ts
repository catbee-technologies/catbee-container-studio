import { constants, type Stats } from 'node:fs';
import { access, chmod, mkdir, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootlessEngineDriver } from '../../../../../src/main/docker/embedded/drivers/rootless-engine.driver';
import {
  getEngineBinDir,
  getEngineRootDir,
  getLinuxRuntimeDir
} from '../../../../../src/main/docker/embedded/engine-paths';
import {
  extractArchive,
  fetchEngineResource,
  getDockerServerVersion,
  pathExists,
  pingDockerEndpoint,
  runCommand,
  updateEngineManifest,
  writeEngineManifest
} from '../../../../../src/main/docker/embedded/engine-utils';
import { DEFAULT_ENGINE_SETTINGS } from '../../../../../src/main/docker/embedded/engine-settings';

vi.mock('electron', () => ({}));
vi.mock('../../../../../src/main/docker/embedded/system-proxy.ts', () => ({ detectSystemProxy: async () => null }));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}));
vi.mock('../../../../../src/main/docker/embedded/engine-settings', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-settings')>();
  return { ...original, getEngineSettings: async () => original.DEFAULT_ENGINE_SETTINGS };
});
vi.mock('../../../../../src/main/docker/embedded/engine-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../src/main/docker/embedded/engine-utils')>()),
  pingDockerEndpoint: vi.fn(),
  extractArchive: vi.fn(),
  fetchEngineResource: vi.fn(),
  getDockerServerVersion: vi.fn(),
  pathExists: vi.fn(),
  runCommand: vi.fn(),
  updateEngineManifest: vi.fn(),
  writeEngineManifest: vi.fn(),
  sleep: vi.fn()
}));

describe('Linux rootless container limits', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['524288', 82_920, 524_288],
    ['4096', 4_096, 4_096],
    ['1048576', 82_920, 1_048_576],
    ['unlimited', 82_920, 524_288]
  ])('sets the container defaults with an inherited hard limit of %s', async (inheritedHard, soft, hard) => {
    vi.mocked(readFile).mockResolvedValue(
      `Max open files            1024                 ${inheritedHard}               files     \n`
    );

    await expect(new RootlessEngineDriver().buildDaemonConfig(DEFAULT_ENGINE_SETTINGS)).resolves.toMatchObject({
      'default-ulimits': { nofile: { Name: 'nofile', Soft: soft, Hard: hard } }
    });
    expect(readFile).toHaveBeenCalledWith('/proc/self/limits', 'utf8');
  });

  it('uses the runtime defaults when the inherited limits cannot be read', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('Cannot read process limits'));

    await expect(new RootlessEngineDriver().buildDaemonConfig(DEFAULT_ENGINE_SETTINGS)).resolves.not.toHaveProperty(
      'default-ulimits'
    );
  });
});

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

describe('Linux rootless installation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readFile).mockRejectedValue(new Error('No AppArmor setting'));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fetchEngineResource).mockResolvedValue(new Response('docker-rootless-extras-29.9.3.tgz'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { preferredExecutable: true, expectedName: 'docker-rootlesskit' },
    { preferredExecutable: false, expectedName: 'rootlesskit' }
  ])('probes AppArmor by launching $expectedName directly', async ({ preferredExecutable, expectedName }) => {
    vi.stubEnv('PATH', 'first tools:second tools');
    const fallback = path.join('first tools', 'rootlesskit');
    const preferred = path.join('second tools', 'docker-rootlesskit');
    vi.mocked(readFile).mockResolvedValue('1');
    vi.mocked(stat).mockImplementation(async file => {
      if (file !== preferred && file !== fallback) throw new Error('Candidate not found');
      return { isFile: () => true } as Stats;
    });
    vi.mocked(access).mockImplementation(async file => {
      if (file === preferred && !preferredExecutable) throw new Error('Candidate is not executable');
    });
    const executable = path.join('resolved tools', expectedName);
    vi.mocked(realpath).mockResolvedValue(executable);
    vi.mocked(runCommand).mockResolvedValue({ stdout: '', stderr: '' });

    const driver = new RootlessEngineDriver();
    vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
    vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    vi.spyOn(driver, 'start').mockResolvedValue(driver.getRunningConnection());

    await driver.install(vi.fn());

    expect(access).toHaveBeenCalledWith(preferred, constants.X_OK);
    expect(realpath).toHaveBeenCalledExactlyOnceWith(preferredExecutable ? preferred : fallback);
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(executable, ['--net=host', '/usr/bin/true'], {
      env: expect.objectContaining({ PATH: expect.stringMatching(/first tools:second tools$/) }),
      timeoutMs: 5_000
    });
  });

  it('keeps the installation incomplete if the extracted engine cannot start', async () => {
    const driver = new RootlessEngineDriver();
    vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
    vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    const start = vi.spyOn(driver, 'start').mockRejectedValue(new Error('dockerd not found'));
    const progress = vi.fn();

    await expect(driver.install(progress)).rejects.toThrow('dockerd not found');
    expect(extractArchive).toHaveBeenCalledTimes(2);
    expect(chmod).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalled();
    expect(start).toHaveBeenCalledExactlyOnceWith(DEFAULT_ENGINE_SETTINGS, expect.any(Function));
    expect(writeEngineManifest).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalledWith(100, expect.any(String));
  });

  it('records a running manifest only after startup succeeds', async () => {
    const driver = new RootlessEngineDriver();
    vi.spyOn(driver, 'checkPrerequisites').mockResolvedValue({ ok: true });
    vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    const start = vi.spyOn(driver, 'start').mockResolvedValue(driver.getRunningConnection());
    vi.mocked(getDockerServerVersion).mockResolvedValue('29.9.3');
    const progress = vi.fn();

    const manifest = await driver.install(progress);
    expect(manifest).toMatchObject({ state: 'running', engineVersion: '29.9.3' });
    expect(writeEngineManifest).toHaveBeenCalledExactlyOnceWith(manifest);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeEngineManifest).mock.invocationCallOrder[0]);
    expect(progress).toHaveBeenLastCalledWith(100, 'Installation complete.');
  });
});
