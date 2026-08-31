import type Docker from 'dockerode';
import { DockerBaseService } from './docker.base.service';
import { DockerProgressEvent } from '../types/docker.types';

export class DockerImageService extends DockerBaseService {
  async listImages(options?: Docker.ListImagesOptions): Promise<Docker.ImageInfo[]> {
    return this.client.listImages(options ?? {});
  }

  async inspectImage(imageId: string): Promise<Docker.ImageInspectInfo> {
    const id = this.normalizeId(imageId, 'Image id');
    return this.client.getImage(id).inspect();
  }

  async pullImage(image: string, options?: {}): Promise<DockerProgressEvent[]> {
    const repoTag = this.normalizeId(image, 'Image');
    const stream = await this.client.pull(repoTag, options ?? {});
    return this.followProgress(stream);
  }

  async pullImageWithProgress(
    image: string,
    options: { abortSignal?: AbortSignal } | undefined,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    const repoTag = this.normalizeId(image, 'Image');
    const stream = await this.client.pull(repoTag, options ?? {});
    return this.followProgressWithUpdates(stream, onProgress);
  }

  async pushImage(repoTag: string, options?: Docker.ImagePushOptions): Promise<DockerProgressEvent[]> {
    const image = this.normalizeId(repoTag, 'Image');
    const stream = await this.client.getImage(image).push(options ?? {});
    return this.followProgress(stream);
  }

  async pushImageWithProgress(
    repoTag: string,
    options: (Docker.ImagePushOptions & { abortSignal?: AbortSignal }) | undefined,
    onProgress: (event: DockerProgressEvent) => void
  ): Promise<DockerProgressEvent[]> {
    const image = this.normalizeId(repoTag, 'Image');
    const stream = await this.client.getImage(image).push(options ?? {});
    return this.followProgressWithUpdates(stream, onProgress);
  }

  async tagImage(imageId: string, repo: string, tag: string): Promise<void> {
    const id = this.normalizeId(imageId, 'Image id');
    const repository = this.normalizeId(repo, 'Repository');
    const nextTag = this.normalizeId(tag, 'Tag');
    await this.client.getImage(id).tag({ repo: repository, tag: nextTag });
  }

  async removeImage(imageId: string, force = false, pruneChildren = false): Promise<Docker.ImageRemoveInfo[]> {
    const id = this.normalizeId(imageId, 'Image id');
    const response = await this.client.getImage(id).remove({ force, noprune: !pruneChildren });
    return (Array.isArray(response) ? response : [response]) as Docker.ImageRemoveInfo[];
  }

  async historyImage(imageId: string): Promise<Docker.Image[]> {
    const id = this.normalizeId(imageId, 'Image id');
    return this.client.getImage(id).history();
  }
}
