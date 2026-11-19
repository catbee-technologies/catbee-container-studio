import type { EngineSettings } from './engine-settings';

export interface ResolvedProxy {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface DaemonConfigOptions {
  /** Listener URIs to write into daemon.json. Omit when the service manager passes -H flags (systemd, rootless). */
  hosts?: string[];
  /** Proxy the daemon itself uses for pulls/pushes. */
  daemonProxy?: ResolvedProxy | null;
  /** Extra keys that a backend must enforce (e.g. features the guest provisioning relies on). */
  extra?: Record<string, unknown>;
}

const IPV6_ULA_SUBNET = ['fd00', 'cb', '', '/64'].join(':');

/** Builds the Docker daemon.json for the built-in engine from the user's settings. */
export function buildDaemonConfig(
  settings: EngineSettings,
  options: DaemonConfigOptions = {}
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    builder: {
      gc: {
        enabled: true,
        defaultKeepStorage: '20GB'
      }
    },
    features: {
      buildkit: true
    },
    'log-driver': 'json-file',
    'log-opts': {
      'max-size': '10m',
      'max-file': '3'
    }
  };

  if (options.hosts?.length) {
    config.hosts = options.hosts;
  }

  const bridgeIp = toBridgeIp(settings.network.dockerSubnet);
  if (bridgeIp) {
    config.bip = bridgeIp;
  }

  if (settings.network.portBindingBehavior === 'localhost') {
    config.ip = '127.0.0.1';
  }

  if (settings.network.defaultNetworkingMode === 'dualstack') {
    config.ipv6 = true;
    config['fixed-cidr-v6'] = IPV6_ULA_SUBNET;
    config.ip6tables = true;
  }

  const proxy = options.daemonProxy;
  if (proxy && (proxy.httpProxy || proxy.httpsProxy)) {
    config.proxies = {
      ...(proxy.httpProxy ? { 'http-proxy': proxy.httpProxy } : {}),
      ...(proxy.httpsProxy ? { 'https-proxy': proxy.httpsProxy } : {}),
      ...(proxy.noProxy ? { 'no-proxy': proxy.noProxy } : {})
    };
  }

  return deepMerge(config, options.extra ?? {});
}

/** Converts a network CIDR such as 192.168.65.0/24 into the bridge gateway form 192.168.65.1/24. */
export function toBridgeIp(subnet: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet.trim());
  if (!match) {
    return null;
  }
  const prefix = Number(match[5]);
  const octets = match.slice(1, 5).map(Number);
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const gateway = ((address & mask) + 1) >>> 0;
  const parts = [gateway >>> 24, (gateway >>> 16) & 255, (gateway >>> 8) & 255, gateway & 255];
  return `${parts.join('.')}/${prefix}`;
}

/**
 * Resolves the proxy the daemon should use from the "Desktop proxy" setting.
 * `systemProxy` is the OS-level proxy detected by Electron (or environment variables).
 */
export function resolveDaemonProxy(settings: EngineSettings, systemProxy: ResolvedProxy | null): ResolvedProxy | null {
  switch (settings.desktopProxy.mode) {
    case 'none':
      return null;
    case 'manual':
      return {
        httpProxy: settings.desktopProxy.httpProxy?.trim() || undefined,
        httpsProxy: settings.desktopProxy.httpsProxy?.trim() || undefined,
        noProxy: settings.desktopProxy.noProxy?.trim() || undefined
      };
    case 'system':
    default:
      return systemProxy;
  }
}

/** Resolves the "Containers proxy" setting (applied via the Docker CLI config and to app-created containers). */
export function resolveContainersProxy(
  settings: EngineSettings,
  systemProxy: ResolvedProxy | null
): ResolvedProxy | null {
  switch (settings.containersProxy.mode) {
    case 'none':
      return null;
    case 'system':
      return systemProxy;
    case 'manual':
      return {
        httpProxy: settings.containersProxy.httpProxy?.trim() || undefined,
        httpsProxy: settings.containersProxy.httpsProxy?.trim() || undefined,
        noProxy: settings.containersProxy.noProxy?.trim() || undefined
      };
    case 'same-as-host':
    default:
      return resolveDaemonProxy(settings, systemProxy);
  }
}

/** Builds proxy environment variables (both cases, as tools disagree) for processes we spawn. */
export function proxyToEnv(proxy: ResolvedProxy | null): Record<string, string> {
  if (!proxy) return {};
  const env: Record<string, string> = {};
  if (proxy.httpProxy) {
    env.HTTP_PROXY = proxy.httpProxy;
    env.http_proxy = proxy.httpProxy;
  }
  if (proxy.httpsProxy) {
    env.HTTPS_PROXY = proxy.httpsProxy;
    env.https_proxy = proxy.httpsProxy;
  }
  if (proxy.noProxy) {
    env.NO_PROXY = proxy.noProxy;
    env.no_proxy = proxy.noProxy;
  }
  return env;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
