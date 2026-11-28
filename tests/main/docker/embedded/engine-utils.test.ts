import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEngineSettings, type DesktopProxyConfig } from '../../../../src/main/docker/embedded/engine-settings';
import { fetchEngineResource } from '../../../../src/main/docker/embedded/engine-utils';

const { fetch, setProxy, sessionFetch, fromPartition, request } = vi.hoisted(() => ({
  fetch: vi.fn(),
  setProxy: vi.fn(),
  sessionFetch: vi.fn(),
  fromPartition: vi.fn(),
  request: vi.fn()
}));
vi.mock('electron', () => ({ net: { fetch, request }, session: { fromPartition } }));
vi.mock('../../../../src/main/docker/embedded/engine-settings', () => ({ getEngineSettings: vi.fn() }));

const url = 'https://downloads.example.test/engine.tar.gz';

function configureProxy(config: Partial<DesktopProxyConfig>): void {
  vi.mocked(getEngineSettings).mockResolvedValue({
    desktopProxy: { mode: 'system', httpProxy: '', httpsProxy: '', noProxy: '', ...config }
  } as Awaited<ReturnType<typeof getEngineSettings>>);
}

describe('engine downloads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setProxy.mockResolvedValue(undefined);
    fromPartition.mockReturnValue({ setProxy, fetch: sessionFetch });
  });

  it('uses Chromium’s default network session for system mode', async () => {
    configureProxy({ mode: 'system' });
    const signal = new AbortController().signal;
    await fetchEngineResource(url, { signal });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { signal });
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it('shares one configured session across concurrent downloads and preserves bypass rules', async () => {
    configureProxy({ mode: 'manual', httpsProxy: 'socks5h://proxy.example.test:1080', noProxy: 'localhost' });
    await Promise.all([fetchEngineResource(url), fetchEngineResource(url)]);
    expect(setProxy).toHaveBeenCalledExactlyOnceWith({
      mode: 'fixed_servers',
      proxyRules: 'https=socks5://proxy.example.test:1080',
      proxyBypassRules: 'localhost'
    });
    expect(sessionFetch).toHaveBeenCalledTimes(2);
  });

  it('sends configured credentials only to the expected proxy and streams the response', async () => {
    const replyOrigin = vi.fn();
    const replyOtherProxy = vi.fn();
    const replyProxy = vi.fn();
    const connection = Object.assign(new EventEmitter(), {
      end() {
        connection.emit('login', { isProxy: false, host: 'proxy.example.test', port: 8080 }, replyOrigin);
        connection.emit('login', { isProxy: true, host: 'other.example.test', port: 8080 }, replyOtherProxy);
        connection.emit('login', { isProxy: true, host: 'proxy.example.test', port: 8080 }, replyProxy);
        connection.emit(
          'response',
          Object.assign(Readable.from([Buffer.from('archive bytes')]), {
            headers: {},
            statusCode: 200,
            statusMessage: 'OK'
          })
        );
      }
    });
    request.mockReturnValue(connection);
    configureProxy({ mode: 'manual', httpsProxy: 'http://user:example@proxy.example.test:8080' });
    const response = await fetchEngineResource(url);
    expect(await response.text()).toBe('archive bytes');
    expect(setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ proxyRules: 'https=http://proxy.example.test:8080' })
    );
    expect(replyOrigin).toHaveBeenCalledExactlyOnceWith();
    expect(replyOtherProxy).toHaveBeenCalledExactlyOnceWith();
    expect(replyProxy).toHaveBeenCalledExactlyOnceWith('user', 'example');
  });
});
