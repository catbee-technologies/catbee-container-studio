export type EngineBackend = 'wsl2' | 'lima' | 'rootless';

export interface EngineManifest {
  schemaVersion: number;
  backend: EngineBackend;
  /** Docker Engine version reported by the daemon (or the installed package version before first start). */
  engineVersion: string;
  /** Versions of supporting components (e.g. limactl, rootlesskit, alpine). */
  components?: Record<string, string>;
  platform: 'win32' | 'darwin' | 'linux';
  architecture: 'x64' | 'arm64';
  distribution: string;
  installedAt: string;
  updatedAt?: string;
  endpoint?: {
    type: 'tcp' | 'unix' | 'npipe';
    address: string;
    port?: number;
  };
  state?: 'stopped' | 'running' | 'error';
}
