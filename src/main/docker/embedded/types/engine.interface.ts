import type { DockerConnection } from '../../types/connection.types';
import type { EngineSettings } from '../engine-settings';
import type { EngineBackend, EngineManifest } from './manifest.types';

export interface PrerequisiteCheckResult {
  ok: boolean;
  reason?: string;
  actionHint?: string;
}

export type EngineDriverStatus = 'running' | 'stopped' | 'error' | 'not-installed';

/** Describes which settings the backend of the current OS can honour, so the UI only shows real options. */
export interface EngineCapabilities {
  backend: EngineBackend;
  backendLabel: string;
  /** True when containers run inside a VM whose resources CatBee controls. */
  managesVmResources: boolean;
  resources: {
    cpus: boolean;
    memory: boolean;
    swap: boolean;
    disk: boolean;
    rosetta: boolean;
  };
  resourcesNote?: string;
  /** True when host directories must be explicitly shared with the VM. */
  fileSharing: boolean;
  fileSharingNote?: string;
  wslIntegration: boolean;
  /** True when changing resources/mounts requires the VM to be stopped and restarted. */
  resourceChangesRequireRestart: boolean;
  /** True when reclaiming memory on idle actually returns it to the host. */
  resourceSaver: boolean;
}

export interface EngineInfo {
  capabilities: EngineCapabilities;
  engineDir: string;
  /** Where container images, volumes and the VM disk live. */
  dataLocation: string;
  logsLocation: string;
  daemonConfigLocation: string;
  distribution: string;
}

/** Reports overall progress (0-100) and a human-readable description of the current step. */
export type EngineProgressCallback = (progress: number, stage: string) => void;

export interface PlatformEngineDriver {
  readonly platform: NodeJS.Platform;
  checkPrerequisites(): Promise<PrerequisiteCheckResult>;
  isInstalled(): Promise<boolean>;
  getManifest(): Promise<EngineManifest | null>;
  install(onProgress: EngineProgressCallback): Promise<EngineManifest>;
  /** Starts (or reconnects to) the engine, applying the current settings first. */
  start(settings: EngineSettings, onStatus?: (status: string) => void): Promise<DockerConnection>;
  stop(): Promise<void>;
  getStatus(): Promise<EngineDriverStatus>;
  /** Endpoint for an engine that is already running (e.g. left running by a previous session). */
  getRunningConnection(): DockerConnection;
  uninstall(onProgress?: EngineProgressCallback): Promise<void>;
  /** Drops guest page caches etc. when Resource Saver kicks in. */
  reclaimMemory(): Promise<void>;
  getCapabilities(): EngineCapabilities;
  getInfo(): EngineInfo;
  /** The daemon.json this backend will write for the given settings. */
  buildDaemonConfig(settings: EngineSettings): Promise<Record<string, unknown>>;
}
