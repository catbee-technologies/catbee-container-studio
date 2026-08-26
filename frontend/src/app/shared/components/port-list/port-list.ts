import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MenuComponent } from '@components/menu/menu';
import { DockerPortInfo } from '@shared/types/docker-api.types';
import { formatDockerPort, normalizeDockerPorts, resolveDockerPortHref } from '@utils/docker-port.utils';
import { ElectronApiService } from '@core/electron-api.service';

@Component({
  selector: 'catbee-container-studio-port-list',
  imports: [CommonModule, MenuComponent],
  templateUrl: './port-list.html',
  styleUrl: './port-list.scss'
})
export class PortListComponent {
  private readonly electronApi = inject(ElectronApiService);

  readonly ports = input<DockerPortInfo[]>([]);
  readonly containerState = input('');
  readonly noPortsLabel = input('-');

  readonly isMenuOpen = signal(false);

  readonly normalizedPorts = computed(() => normalizeDockerPorts(this.ports()));
  readonly firstPort = computed(() => this.normalizedPorts()[0] ?? null);
  readonly hasMultiple = computed(() => this.normalizedPorts().length > 1);

  formatPort(port: DockerPortInfo): string {
    return formatDockerPort(port);
  }

  portHref(port: DockerPortInfo): string | null {
    return resolveDockerPortHref(port, this.containerState());
  }

  toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.isMenuOpen.update(value => !value);
  }

  closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  async openPort(event: MouseEvent, href: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.electronApi.openExternalUrl(href);
  }
}
