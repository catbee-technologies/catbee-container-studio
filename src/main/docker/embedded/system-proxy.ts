import { session } from 'electron';
import { logger } from '../../logger';
import type { ResolvedProxy } from './daemon-config';

const PROBE_URL = 'https://registry-1.docker.io';

/**
 * Detects the OS proxy (macOS/Windows system settings, PAC, or Linux env/GNOME) via Chromium's resolver,
 * falling back to the conventional proxy environment variables.
 */
export async function detectSystemProxy(): Promise<ResolvedProxy | null> {
  /* eslint-disable n/no-process-env */
  const envProxy: ResolvedProxy = {
    httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy,
    httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy
  };
  /* eslint-enable n/no-process-env */

  try {
    const resolved = await session.defaultSession.resolveProxy(PROBE_URL);
    const first = resolved
      .split(';')
      .map(entry => entry.trim())
      .find(entry => /^(PROXY|HTTPS)\s+/i.test(entry));
    if (first) {
      const [scheme, hostPort] = first.split(/\s+/);
      const url = `${scheme.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${hostPort}`;
      return {
        httpProxy: url,
        httpsProxy: url,
        noProxy: envProxy.noProxy ?? 'localhost,127.0.0.1'
      };
    }
  } catch (err) {
    logger.debug({ err }, '[SystemProxy] Chromium proxy resolution failed; using environment variables.');
  }

  if (envProxy.httpProxy || envProxy.httpsProxy) {
    return envProxy;
  }
  return null;
}
