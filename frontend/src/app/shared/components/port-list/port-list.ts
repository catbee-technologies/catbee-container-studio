import { CommonModule } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { DockerApiService } from '@core/docker-api.service';
import { MenuComponent } from '@components/menu/menu';
import { DockerPortInfo } from '@shared/types/docker-api.types';
import { formatDockerPort, normalizeDockerPorts, resolveDockerPortHref } from '@utils/docker-port.utils';
import { MenuService } from '@components/menu/menu.service';

@Component({
  selector: 'catbee-container-studio-port-list',
  imports: [CommonModule, MenuComponent],
  templateUrl: './port-list.html',
  styleUrl: './port-list.scss'
})
export class PortListComponent {
  private readonly dockerApi = inject(DockerApiService);
  private readonly menuState = inject(MenuService);
  private readonly menuId = Symbol('port-menu');

  readonly ports = input<DockerPortInfo[]>([]);
  readonly containerState = input('');
  readonly noPortsLabel = input('-');

  readonly normalizedPorts = computed(() => normalizeDockerPorts(this.ports()));
  readonly firstPort = computed(() => this.normalizedPorts()[0] ?? null);
  readonly hasMultiple = computed(() => this.normalizedPorts().length > 1);

  formatPort(port: DockerPortInfo): string {
    return formatDockerPort(port);
  }

  portHref(port: DockerPortInfo): string | null {
    return resolveDockerPortHref(port, this.containerState());
  }

  isMenuOpen(): boolean {
    return this.menuState.isOpen(this.menuId);
  }

  toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.menuState.toggle(this.menuId);
  }

  closeMenu(): void {
    this.menuState.close(this.menuId);
  }

  async openPort(event: MouseEvent, href: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.dockerApi.openExternalUrl(href);
  }
}
