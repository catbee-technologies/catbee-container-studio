import { CommonModule } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { DockerContainerInfo } from '@shared/types/docker-api.types';
import { formatDockerNames } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-connected-containers-table',
  imports: [CommonModule, EmptyStateComponent, CopyButtonComponent, CatbeeTooltip],
  templateUrl: './connected-containers-table.html',
  styleUrl: './connected-containers-table.scss'
})
export class ConnectedContainersTableComponent {
  private readonly router = inject(Router);

  readonly containers = input.required<DockerContainerInfo[]>();
  readonly emptyMessage = input<string>('No containers found.');
  readonly emptyHint = input<string>('');
  readonly emptyIcon = input<string>('storage');
  readonly addressProvider = input<((containerId: string) => string) | null>(null);
  readonly currentImageId = input<string | null>(null);

  readonly tooltipDelay = 300;

  openContainer(containerId: string): void {
    void this.router.navigate(['/containers', containerId], {
      state: { returnTo: this.router.url }
    });
  }

  openImageDetails(imageRef: string): void {
    void this.router.navigate(['/images', imageRef], {
      state: { returnTo: this.router.url }
    });
  }

  formatContainerName(container: DockerContainerInfo): string {
    return formatDockerNames(container.Names);
  }

  shortId(id: string): string {
    return id.replace('sha256:', '').slice(0, 12);
  }
}
