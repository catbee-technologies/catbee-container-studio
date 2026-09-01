import { Component, computed, inject, input } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { FileBrowserComponent, FileBrowserDataSource } from '@components/file-browser/file-browser';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';

@Component({
  selector: 'catbee-container-studio-container-files-tab',
  imports: [FileBrowserComponent],
  template: `
    <catbee-container-studio-file-browser
      [dataSource]="dataSource"
      [rootPath]="'/'"
      [storageKey]="storageKey()"
      ariaLabel="Container filesystem"
    />
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }
  `
})
export class FilesTabComponent {
  private static readonly CONTAINER_STOPPED_OR_PAUSED_RE =
    /container (?:(?:stopped\/paused|stopped|paused)\b|[^\r\n]*\bis (?:not running|paused)\b)/i;
  private static readonly SHELL_NOT_FOUND_RE =
    /executable file not found|no such file or directory|exec: "(?:sh|bash|ash|zsh)": stat/i;
  private static readonly FILE_NOT_FOUND_RE = /\(HTTP code 404\).*Could not find the file\b/i;

  private readonly dockerApi = inject(DockerApiService);

  readonly containerId = input.required<string>();
  readonly storageKey = computed(() => `${UI_STORAGE_KEYS.CONTAINERS_FILES_PATH_PREFIX}${this.containerId()}`);

  readonly dataSource: FileBrowserDataSource = {
    list: path => this.dockerApi.listContainerFiles(this.containerId(), path),
    read: path => this.dockerApi.readContainerFile(this.containerId(), path),
    write: (path, data) => this.dockerApi.uploadContainerFile(this.containerId(), path, data),
    delete: path => this.dockerApi.deleteContainerFile(this.containerId(), path),
    getUnavailableState: error => {
      const message = error instanceof Error ? error.message : '';
      if (FilesTabComponent.CONTAINER_STOPPED_OR_PAUSED_RE.test(message)) {
        return {
          message: 'Container filesystem is unavailable.',
          hint: 'Start or unpause the container, then refresh the directory.'
        };
      }

      if (FilesTabComponent.SHELL_NOT_FOUND_RE.test(message)) {
        return {
          message: 'This container does not include a supported shell.',
          hint: 'Filesystem browsing requires sh, bash, ash, or zsh inside the container.'
        };
      }

      if (FilesTabComponent.FILE_NOT_FOUND_RE.test(message)) {
        return {
          message: 'File is no longer available.',
          hint: 'It may have been removed or changed recently.'
        };
      }

      return null;
    }
  };
}
