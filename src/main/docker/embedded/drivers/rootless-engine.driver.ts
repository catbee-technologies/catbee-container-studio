import { logger } from '../../../logger';
import type { DockerConnection } from '../../types/connection.types';
import type { EngineManifest } from '../types/manifest.types';
import type { PlatformEngineDriver, PrerequisiteCheckResult } from '../types/engine.interface';

export class RootlessEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'linux';

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    logger.debug('[RootlessEngineDriver] Checking Linux prerequisites.');
    if (process.platform !== 'linux') {
      return {
        ok: false,
        reason: 'Rootless container driver is only supported on Linux.',
        actionHint: 'Use the platform-native container engine for your operating system.'
      };
    }

    return {
      ok: true
    };
  }

  async isInstalled(): Promise<boolean> {
    return false;
  }

  async getManifest(): Promise<EngineManifest | null> {
    return null;
  }

  async install(_onProgress: (progress: number, stage: string) => void): Promise<EngineManifest> {
    throw new Error('Embedded Linux rootless engine driver is coming soon. Please use the system Docker service.');
  }

  async start(_onStatus?: (status: string) => void): Promise<DockerConnection> {
    throw new Error('Embedded Linux rootless engine driver is coming soon.');
  }

  async stop(): Promise<void> {
    // No-op for stub
  }

  async getStatus(): Promise<'running' | 'stopped' | 'error' | 'not-installed'> {
    return 'not-installed';
  }
}
