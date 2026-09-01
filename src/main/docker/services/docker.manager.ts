import type Docker from 'dockerode';
import { DockerInitializationStatus } from '../types/runtime.types';
import { DockerContainerService } from './docker.container.service';
import { DockerExecService } from './docker.exec.service';
import { DockerImageService } from './docker.image.service';
import { DockerNetworkService } from './docker.network.service';
import { DockerSystemService } from './docker.system.service';
import { DockerVolumeService } from './docker.volume.service';
import { DockerRuntimeManager } from '../runtime/docker.runtime-manager';

export class DockerManager {
  private client!: Docker;
  private rendererReady = false;
  private latestStatus: DockerInitializationStatus | null = null;
  private statusListener?: (status: DockerInitializationStatus) => void;

  private readonly runtimeManager = new DockerRuntimeManager();

  containers!: DockerContainerService;
  exec!: DockerExecService;
  images!: DockerImageService;
  networks!: DockerNetworkService;
  system!: DockerSystemService;
  volumes!: DockerVolumeService;

  async initialize(
    onStatus?: (status: DockerInitializationStatus) => void,
    onRuntimeStarted?: () => void
  ): Promise<void> {
    this.statusListener = onStatus;

    this.emitStatus({
      state: 'checking',
      message: 'Checking Docker availability...',
      hint: 'Verifying if Docker Engine is running and accessible.'
    });

    this.client = await this.runtimeManager.ensureDockerAvailable(status => this.emitStatus(status), onRuntimeStarted);

    this.emitStatus({
      state: 'ready',
      message: 'Docker Engine is ready.',
      hint: 'Docker Engine is running and accessible.'
    });

    this.initializeServices();
  }

  private initializeServices(): void {
    this.containers = new DockerContainerService(this.client);
    this.exec = new DockerExecService(this.client);
    this.images = new DockerImageService(this.client);
    this.networks = new DockerNetworkService(this.client);
    this.system = new DockerSystemService(this.client);
    this.volumes = new DockerVolumeService(this.client, this.containers, this.images);
  }

  setRendererReady(): void {
    this.rendererReady = true;
    if (this.latestStatus) {
      this.statusListener?.(this.latestStatus);
    }
  }

  private emitStatus(status: DockerInitializationStatus): void {
    this.latestStatus = status;
    if (this.rendererReady) {
      this.statusListener?.(status);
    }
  }
}

export const dockerManager = new DockerManager();
