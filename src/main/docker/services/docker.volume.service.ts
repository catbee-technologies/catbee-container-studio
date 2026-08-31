import type Docker from 'dockerode';
import { DockerBaseService } from './docker.base.service';

export class DockerVolumeService extends DockerBaseService {
  async listVolumes(
    options?: Docker.VolumeListOptions
  ): Promise<{ Volumes: Docker.VolumeInspectInfo[]; Warnings: string[] }> {
    return this.client.listVolumes(options ?? {});
  }

  async inspectVolume(name: string): Promise<Docker.VolumeInspectInfo> {
    const volumeName = this.normalizeId(name, 'Volume name');
    return this.client.getVolume(volumeName).inspect();
  }

  async createVolume(options: Docker.VolumeCreateOptions): Promise<Docker.VolumeCreateResponse> {
    return this.client.createVolume(options);
  }

  async removeVolume(name: string, force = false): Promise<void> {
    const volumeName = this.normalizeId(name, 'Volume name');
    await this.client.getVolume(volumeName).remove({ force });
  }
}
