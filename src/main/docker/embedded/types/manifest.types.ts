export interface EngineManifest {
  schemaVersion: number;
  engineVersion: string;
  platform: 'win32' | 'darwin' | 'linux';
  architecture: 'x64' | 'arm64';
  distribution: 'alpine' | 'ubuntu';
  installedAt: string;
  updatedAt?: string;
  endpoint: {
    type: 'tcp' | 'unix' | 'npipe';
    address: string;
    port?: number;
  };
  state?: 'stopped' | 'running' | 'error';
}
