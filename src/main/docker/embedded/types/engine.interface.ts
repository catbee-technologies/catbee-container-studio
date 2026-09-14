import type { DockerConnection } from '../../types/connection.types';
import type { EngineManifest } from './manifest.types';

export interface PrerequisiteCheckResult {
  ok: boolean;
  reason?: string;
  actionHint?: string;
}

export interface PlatformEngineDriver {
  readonly platform: NodeJS.Platform;
  checkPrerequisites(): Promise<PrerequisiteCheckResult>;
  isInstalled(): Promise<boolean>;
  getManifest(): Promise<EngineManifest | null>;
  install(onProgress: (progress: number, stage: string) => void): Promise<EngineManifest>;
  start(onStatus?: (status: string) => void): Promise<DockerConnection>;
  stop(): Promise<void>;
  getStatus(): Promise<'running' | 'stopped' | 'error' | 'not-installed'>;
}
