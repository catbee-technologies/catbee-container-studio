import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { WindowHeaderComponent } from '@components/window-header/window-header';
import { LocalStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@shared/utils/storage.utils';

@Component({
  selector: 'catbee-container-studio-root',
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, WindowHeaderComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private readonly localStorage = inject(LocalStorageService);
  readonly sidebarCollapsed = signal(this.readSidebarCollapsedPreference());

  readonly navItems = [
    { label: 'Containers', icon: 'deployed_code', route: '/containers' },
    { label: 'Images', icon: 'image', route: '/images' },
    { label: 'Volumes', icon: 'database', route: '/volumes' }
  ];

  onNavClick(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
    }
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.update(current => {
      const next = !current;
      this.localStorage.set(UI_STORAGE_KEYS.SIDEBAR_COLLAPSED, next ? 'true' : 'false');
      return next;
    });
  }

  private readSidebarCollapsedPreference(): boolean {
    return this.localStorage.getBoolean(UI_STORAGE_KEYS.SIDEBAR_COLLAPSED) === true;
  }
}
