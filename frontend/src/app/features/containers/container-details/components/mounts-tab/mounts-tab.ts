import { CommonModule } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { DockerApiService } from '@core/docker-api.service';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { DockerContainerInspectInfo } from '@shared/types/docker-api.types';
import { ElectronApiService } from '@core/electron-api.service';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

interface MountRow {
  type: string;
  source: string;
  name: string;
  displaySource: string;
  destination: string;
  mode: string;
  readWrite: boolean;
  propagation: string;
}

@Component({
  selector: 'catbee-container-studio-container-mounts-tab',
  imports: [CommonModule, EmptyStateComponent, CatbeeTooltip],
  templateUrl: './mounts-tab.html',
  styleUrl: './mounts-tab.scss'
})
export class MountsTabComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly router = inject(Router);

  readonly inspectData = input<DockerContainerInspectInfo | null>(null);

  readonly mountRows = computed<MountRow[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }

    const record = inspectData as {
      Mounts?: {
        Type?: unknown;
        Name?: unknown;
        Source?: unknown;
        Destination?: unknown;
        Mode?: unknown;
        RW?: unknown;
        Propagation?: unknown;
      }[];
    };

    if (!Array.isArray(record.Mounts)) {
      return [];
    }

    return record.Mounts.map(item => {
      const type = typeof item.Type === 'string' ? item.Type : '--';
      const source = typeof item.Source === 'string' ? item.Source : '--';
      const name = typeof item.Name === 'string' && item.Name.length > 0 ? item.Name : '--';
      const displaySource = type === 'volume' && name !== '--' ? name : source;

      return {
        type,
        source,
        name,
        displaySource,
        destination: typeof item.Destination === 'string' ? item.Destination : '--',
        mode: typeof item.Mode === 'string' && item.Mode.length > 0 ? item.Mode : '--',
        readWrite: Boolean(item.RW),
        propagation: typeof item.Propagation === 'string' && item.Propagation.length > 0 ? item.Propagation : '--'
      };
    }).sort((a, b) => a.destination.localeCompare(b.destination));
  });

  readonly declaredVolumeNames = computed<string[]>(() => {
    const inspectData = this.inspectData();
    if (!inspectData || typeof inspectData !== 'object') {
      return [];
    }

    const record = inspectData as { Config?: { Volumes?: unknown } };
    const volumes = record.Config?.Volumes;
    if (!volumes || typeof volumes !== 'object') {
      return [];
    }

    return Object.keys(volumes as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  });

  readonly readOnlyMountCount = computed(() => this.mountRows().filter(row => !row.readWrite).length);
  readonly readWriteMountCount = computed(() => this.mountRows().filter(row => row.readWrite).length);

  openMountSource(mount: MountRow): void {
    if (mount.source === '--') {
      return;
    }

    if (mount.type === 'volume' && mount.name !== '--') {
      void this.router.navigate(['/volumes', mount.name], { state: { returnTo: this.router.url } });
      return;
    }

    this.openSource(mount.source);
  }

  openSource(source: string): void {
    if (source && source !== '--') {
      this.electronApi.showItemInFolder(source);
    }
  }
}
