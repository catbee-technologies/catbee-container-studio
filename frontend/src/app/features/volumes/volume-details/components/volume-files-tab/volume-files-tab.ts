import { Component, computed, inject, input } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { FileBrowserComponent, FileBrowserDataSource } from '@components/file-browser/file-browser';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';

@Component({
  selector: 'catbee-container-studio-volume-files-tab',
  imports: [FileBrowserComponent],
  template: `
    <catbee-container-studio-file-browser
      [dataSource]="dataSource"
      [rootPath]="'/'"
      [storageKey]="storageKey()"
      ariaLabel="Volume filesystem"
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
export class VolumeFilesTabComponent {
  private static readonly HELPER_IMAGE_ERROR_RE = /pull access denied|manifest unknown|no such image|network|timeout/i;

  private readonly dockerApi = inject(DockerApiService);

  readonly volumeName = input.required<string>();
  readonly storageKey = computed(() => `${UI_STORAGE_KEYS.VOLUMES_FILES_PATH_PREFIX}${this.volumeName()}`);

  readonly dataSource: FileBrowserDataSource = {
    list: path => this.dockerApi.listVolumeFiles(this.volumeName(), path),
    read: path => this.dockerApi.readVolumeFile(this.volumeName(), path),
    write: (path, data) => this.dockerApi.writeVolumeFile(this.volumeName(), path, data),
    delete: path => this.dockerApi.deleteVolumeFile(this.volumeName(), path),
    getUnavailableState: error => {
      const message = error instanceof Error ? error.message : '';
      if (!VolumeFilesTabComponent.HELPER_IMAGE_ERROR_RE.test(message)) {
        return null;
      }

      return {
        message: 'Volume files are temporarily unavailable.',
        hint: 'Check the Docker network connection and try again. The file helper image may need to be downloaded.'
      };
    }
  };
}
