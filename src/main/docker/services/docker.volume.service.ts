import type Docker from 'dockerode';
import { posix } from 'node:path';
import { DockerBaseService } from './docker.base.service';
import { DockerContainerService } from './docker.container.service';
import { DockerImageService } from './docker.image.service';
import { DockerFileEntry } from '../types/docker.types';

export class DockerVolumeService extends DockerBaseService {
  private static readonly FILE_HELPER_IMAGE = 'alpine:3.20';
  private static readonly FILE_HELPER_MOUNT_PATH = '/data';

  private helperImagePromise: Promise<void> | null = null;

  constructor(
    client: Docker,
    private readonly containers: DockerContainerService,
    private readonly images: DockerImageService
  ) {
    super(client);
  }

  async listVolumes(
    options?: Docker.VolumeListOptions
  ): Promise<{ Volumes: Docker.VolumeInspectInfo[]; Warnings: string[] }> {
    return this.client.listVolumes(options ?? {});
  }

  async inspectVolume(name: string): Promise<Docker.VolumeInspectInfo> {
    const volumeName = this.normalizeId(name, 'Volume name');
    return this.client.getVolume(volumeName).inspect();
  }

  async getVolumeUsage(name?: string): Promise<Record<string, { Size: number; RefCount: number }>> {
    const volumeName = name ? this.normalizeId(name, 'Volume name') : null;
    const diskUsage = (await this.client.df()) as {
      Volumes?: Array<Docker.VolumeInspectInfo & { UsageData?: { Size: number; RefCount: number } | null }>;
    };
    const usageByName: Record<string, { Size: number; RefCount: number }> = {};

    for (const volume of diskUsage.Volumes ?? []) {
      if (volume.UsageData && (!volumeName || volume.Name === volumeName)) {
        usageByName[volume.Name] = volume.UsageData;
      }
    }

    return usageByName;
  }

  async createVolume(options: Docker.VolumeCreateOptions): Promise<Docker.VolumeCreateResponse> {
    return this.client.createVolume(options);
  }

  async removeVolume(name: string, force = false): Promise<void> {
    const volumeName = this.normalizeId(name, 'Volume name');
    await this.client.getVolume(volumeName).remove({ force });
  }

  async listVolumeFiles(name: string, path = '/'): Promise<DockerFileEntry[]> {
    const normalizedPath = this.normalizeVolumePath(path);
    return this.withFileHelper(name, async containerId => {
      const entries = await this.containers.listContainerFiles(containerId, this.toHelperPath(normalizedPath));
      return entries.map(entry => ({ ...entry, path: this.fromHelperPath(entry.path) }));
    });
  }

  async readVolumeFile(name: string, path: string): Promise<Buffer> {
    const normalizedPath = this.normalizeVolumePath(path);
    return this.withFileHelper(name, containerId =>
      this.containers.readContainerFile(containerId, this.toHelperPath(normalizedPath))
    );
  }

  async writeVolumeFile(name: string, path: string, data: Buffer): Promise<void> {
    const normalizedPath = this.normalizeVolumePath(path);
    return this.withFileHelper(name, containerId =>
      this.containers.writeContainerFile(containerId, this.toHelperPath(normalizedPath), Buffer.from(data))
    );
  }

  async deleteVolumeFile(name: string, path: string): Promise<void> {
    const normalizedPath = this.normalizeVolumePath(path);
    if (normalizedPath === '/') {
      throw new Error('Cannot delete the volume root directory.');
    }
    return this.withFileHelper(name, containerId =>
      this.containers.deleteContainerFile(containerId, this.toHelperPath(normalizedPath))
    );
  }

  private async withFileHelper<T>(name: string, operation: (containerId: string) => Promise<T>): Promise<T> {
    const volumeName = this.normalizeId(name, 'Volume name');
    await this.inspectVolume(volumeName);
    await this.ensureFileHelperImage();

    const helper = await this.client.createContainer({
      Image: DockerVolumeService.FILE_HELPER_IMAGE,
      Cmd: ['sh', '-c', 'while :; do sleep 3600; done'],
      Labels: { 'com.catbee.container-studio.volume-helper': 'true' },
      HostConfig: {
        Mounts: [
          {
            Type: 'volume',
            Source: volumeName,
            Target: DockerVolumeService.FILE_HELPER_MOUNT_PATH
          }
        ]
      }
    });

    try {
      await helper.start();
      return await operation(helper.id);
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  }

  private async ensureFileHelperImage(): Promise<void> {
    this.helperImagePromise ??= this.loadFileHelperImage().catch(error => {
      this.helperImagePromise = null;
      throw error;
    });
    return this.helperImagePromise;
  }

  private async loadFileHelperImage(): Promise<void> {
    try {
      await this.images.inspectImage(DockerVolumeService.FILE_HELPER_IMAGE);
    } catch {
      await this.images.pullImage(DockerVolumeService.FILE_HELPER_IMAGE);
    }
  }

  private normalizeVolumePath(path: string): string {
    const normalized = posix.normalize(`/${path.trim()}`);
    return normalized === '.' ? '/' : normalized;
  }

  private toHelperPath(path: string): string {
    return path === '/'
      ? DockerVolumeService.FILE_HELPER_MOUNT_PATH
      : `${DockerVolumeService.FILE_HELPER_MOUNT_PATH}${path}`;
  }

  private fromHelperPath(path: string): string {
    const relativePath = path.slice(DockerVolumeService.FILE_HELPER_MOUNT_PATH.length);
    return relativePath || '/';
  }
}
