import { CommonModule } from '@angular/common';
import { Component, inject, input, output } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { DockerPortInfo } from '@shared/types/docker-api.types';
import { formatDockerPort, normalizeDockerPorts, resolveDockerPortHref } from '@utils/docker-port.utils';

@Component({
  selector: 'catbee-container-studio-port-list',
  imports: [CommonModule],
  templateUrl: './port-list.html',
  styleUrl: './port-list.scss'
})
export class PortListComponent {
  private readonly dockerApi = inject(DockerApiService);

  readonly ports = input<DockerPortInfo[]>([]);
  readonly containerState = input('');
  readonly expanded = input(false);
  readonly collapseAt = input(2);
  readonly noPortsLabel = input('-');
  readonly mono = input(false);

  readonly expandedChange = output<boolean>();

  normalizedPorts(): DockerPortInfo[] {
    return normalizeDockerPorts(this.ports());
  }

  visiblePorts(): DockerPortInfo[] {
    const all = this.normalizedPorts();
    if (this.expanded()) {
      return all;
    }

    return all.slice(0, this.collapseAt());
  }

  shouldShowToggle(): boolean {
    return this.normalizedPorts().length > this.collapseAt();
  }

  formatPort(port: DockerPortInfo): string {
    return formatDockerPort(port);
  }

  portHref(port: DockerPortInfo): string | null {
    return resolveDockerPortHref(port, this.containerState());
  }

  toggleExpanded(event: MouseEvent): void {
    event.stopPropagation();
    this.expandedChange.emit(!this.expanded());
  }

  async openPortLink(event: MouseEvent, href: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.dockerApi.openExternalUrl(href);
  }
}
