import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_SETTINGS,
  getEngineSettings,
  isValidIpv4Cidr,
  mergeEngineSettings,
  resetEngineSettings,
  saveEngineSettings
} from '../../../../src/main/docker/embedded/engine-settings';

const { getEngineSettingsFilePath } = vi.hoisted(() => ({ getEngineSettingsFilePath: vi.fn<() => string>() }));
vi.mock('../../../../src/main/docker/embedded/engine-paths', () => ({ getEngineSettingsFilePath }));
vi.mock('../../../../src/main/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('engine settings', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'catbee-settings-test-'));
    file = path.join(directory, 'settings.json');
    getEngineSettingsFilePath.mockReturnValue(file);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['10.0.0.0/8', true],
    [' 192.168.1.0/30 ', true],
    ['256.0.0.0/24', false],
    ['10.0.0.0/31', false],
    ['10.0.0.0/7', false],
    ['::1/64', false]
  ])('validates the Docker subnet %s', (cidr, valid) => {
    expect(isValidIpv4Cidr(cidr)).toBe(valid);
  });

  it('normalizes stored settings while retaining defaults for omitted fields', () => {
    const result = mergeEngineSettings(DEFAULT_ENGINE_SETTINGS, {
      resourceSaverTimeout: 1,
      wslAdditionalDistros: [' Ubuntu ', '', 'Ubuntu', 'Debian'],
      kubernetes: { ...DEFAULT_ENGINE_SETTINGS.kubernetes, version: ' v1.34.0 ', nodeCount: 99 },
      network: { ...DEFAULT_ENGINE_SETTINGS.network, dockerSubnet: 'not-a-subnet' }
    });
    expect(result).toMatchObject({
      resourceSaverTimeout: 30,
      wslAdditionalDistros: ['Ubuntu', 'Debian'],
      kubernetes: { version: 'v1.34.0', nodeCount: 8 },
      network: { dockerSubnet: DEFAULT_ENGINE_SETTINGS.network.dockerSubnet },
      desktopProxy: DEFAULT_ENGINE_SETTINGS.desktopProxy
    });
  });

  it('recovers from unreadable JSON and preserves embedded mode on reset', async () => {
    await writeFile(file, '{bad json');
    expect((await getEngineSettings()).engineMode).toBe('auto');
    await saveEngineSettings({ engineMode: 'embedded', exposeTcp: true });
    await resetEngineSettings();
    expect(await getEngineSettings()).toMatchObject({ engineMode: 'embedded', exposeTcp: false });
  });

  it('defaults host file change forwarding to off and preserves an explicit opt-in until reset', async () => {
    await writeFile(file, JSON.stringify({ engineMode: 'embedded' }));
    expect((await getEngineSettings()).forwardHostFileChanges).toBe(false);

    await saveEngineSettings({ forwardHostFileChanges: true });
    await saveEngineSettings({ exposeTcp: true });
    expect((await getEngineSettings()).forwardHostFileChanges).toBe(true);

    await resetEngineSettings();
    expect((await getEngineSettings()).forwardHostFileChanges).toBe(false);
  });

  it('serializes patches and allows later writes after an apply failure', async () => {
    const applying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = saveEngineSettings({ exposeTcp: true }, async () => {
      applying.resolve();
      await release.promise;
      throw new Error('could not apply WSL changes');
    });
    const rejected = expect(first).rejects.toThrow('could not apply WSL changes');
    await applying.promise;
    const second = saveEngineSettings({ resourceSaverEnabled: true });
    release.resolve();
    await rejected;
    await second;
    expect(await getEngineSettings()).toMatchObject({ exposeTcp: false, resourceSaverEnabled: true });
  });
});
