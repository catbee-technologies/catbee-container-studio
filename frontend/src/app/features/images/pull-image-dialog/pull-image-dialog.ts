import { Component, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { DockerProgressEvent, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { DialogComponent } from '@components/dialog/dialog';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';

interface PullProgressLine {
  id: string;
  text: string;
}

@Component({
  selector: 'catbee-container-studio-pull-image-dialog',
  imports: [DialogComponent, ErrorBannerComponent],
  templateUrl: './pull-image-dialog.html',
  styleUrl: './pull-image-dialog.scss'
})
export class PullImageDialogComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = input(false);
  readonly initialReference = input('');

  readonly closeDialog = output<void>();
  readonly pulled = output<void>();

  readonly reference = signal('');
  readonly isPulling = signal(false);
  readonly progressLines = signal<PullProgressLine[]>([]);
  readonly error = signal<string | null>(null);

  private pullStreamId: string | null = null;

  constructor() {
    const unsubscribe = this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));
    this.destroyRef.onDestroy(() => {
      unsubscribe();
      void this.stopPull();
    });

    effect(() => {
      if (this.open()) {
        this.reference.set(this.initialReference());
        this.progressLines.set([]);
        this.error.set(null);
        this.isPulling.set(false);
      }
    });
  }

  onClose(): void {
    if (this.isPulling()) {
      return;
    }
    this.closeDialog.emit();
  }

  async startPull(): Promise<void> {
    const image = this.reference().trim();
    if (!image || this.isPulling()) {
      return;
    }

    this.isPulling.set(true);
    this.error.set(null);
    this.progressLines.set([]);

    try {
      const result = await this.dockerApi.startPullStream(image);
      this.pullStreamId = result.streamId;
    } catch (error) {
      this.isPulling.set(false);
      this.error.set(error instanceof Error ? error.message : 'Failed to start pulling the image.');
    }
  }

  private onStreamEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind !== 'pull' || event.streamId !== this.pullStreamId) {
      return;
    }

    if (event.type === 'data') {
      const progress = event.data as DockerProgressEvent;
      this.pushProgressLine(progress);
      return;
    }

    if (event.type === 'error') {
      this.isPulling.set(false);
      this.pullStreamId = null;
      this.error.set(event.error ?? 'Image pull failed.');
      return;
    }

    if (event.type === 'end') {
      this.isPulling.set(false);
      this.pullStreamId = null;
      this.pulled.emit();
    }
  }

  private pushProgressLine(progress: DockerProgressEvent): void {
    const status = progress.status ?? progress.stream ?? '';
    if (!status) {
      return;
    }
    const text = progress.progress ? `${status} ${progress.progress}` : status;
    const id = progress.id ?? status;

    this.progressLines.update(lines => {
      const existingIndex = lines.findIndex(line => line.id === id);
      if (existingIndex === -1) {
        return [...lines, { id, text }];
      }
      const next = [...lines];
      next[existingIndex] = { id, text };
      return next;
    });
  }

  private async stopPull(): Promise<void> {
    const streamId = this.pullStreamId;
    this.pullStreamId = null;
    if (streamId) {
      await this.dockerApi.stopStream(streamId).catch(() => undefined);
    }
  }
}
