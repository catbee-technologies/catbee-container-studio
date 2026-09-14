import { logger } from '../../../logger';
import type { DockerConnection } from '../../types/connection.types';
import type { EngineManifest } from '../types/manifest.types';
import type { PlatformEngineDriver, PrerequisiteCheckResult } from '../types/engine.interface';

export class VzEngineDriver implements PlatformEngineDriver {
  readonly platform: NodeJS.Platform = 'darwin';

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    logger.debug('[VzEngineDriver] Checking macOS prerequisites.');
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        reason: 'Apple Virtualization engine driver is only supported on macOS.',
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
    throw new Error('Embedded macOS container engine driver is coming soon. Please use an external Docker engine.');
  }

  async start(_onStatus?: (status: string) => void): Promise<DockerConnection> {
    throw new Error('Embedded macOS container engine driver is coming soon.');
  }

  async stop(): Promise<void> {
    // No-op for stub
  }

  async getStatus(): Promise<'running' | 'stopped' | 'error' | 'not-installed'> {
    return 'not-installed';
  }
}
