import { CommonModule } from '@angular/common';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { timer, exhaustMap, from, catchError, of } from 'rxjs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { WindowHeaderComponent } from '@components/window-header/window-header';
import { DockerApiService } from '@core/docker-api.service';
import { LocalStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@shared/utils/storage.utils';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EmptyStateComponent } from '@components/empty-state/empty-state';

@Component({
  selector: 'catbee-container-studio-root',
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, WindowHeaderComponent, EmptyStateComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly localStorage = inject(LocalStorageService);
  private readonly dockerApi = inject(DockerApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sidebarCollapsed = signal(this.readSidebarCollapsedPreference());
  readonly dockerConnected = signal(true); // Assume connected until checked

  readonly navItems = [
    { label: 'Containers', icon: 'deployed_code', route: '/containers' },
    { label: 'Images', icon: 'image', route: '/images' },
    { label: 'Volumes', icon: 'database', route: '/volumes' }
  ];

  ngOnInit(): void {
    timer(0, 5000)
      .pipe(
        exhaustMap(() => from(this.dockerApi.pingDockerEngine()).pipe(catchError(() => of(false)))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(isConnected => {
        console.log('Docker connected:', isConnected);
        this.dockerConnected.set(isConnected);
      });
  }

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
