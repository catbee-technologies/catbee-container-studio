import { CommonModule } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { timer, exhaustMap, from, catchError, of } from 'rxjs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { WindowHeaderComponent } from '@components/window-header/window-header';
import { DockerApiService } from '@core/docker-api.service';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@shared/utils/storage.utils';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ElectronApiService } from '@core/electron-api.service';
import { DockerInitializationStatus } from '@shared/types';

@Component({
  selector: 'catbee-container-studio-root',
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, WindowHeaderComponent, EmptyStateComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);
  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly destroyRef = inject(DestroyRef);
   
  readonly sidebarCollapsed = signal(
    this.localStorage.getBooleanWithDefault(UI_STORAGE_KEYS.SIDEBAR_COLLAPSED, UI_STORAGE_DEFAULTS.SIDEBAR_COLLAPSED)
  );
  readonly dockerConnected = signal(true); // Assume connected until checked
  readonly dockerInitStatus = signal<DockerInitializationStatus>(this.sessionStorage.getJsonWithDefault<DockerInitializationStatus>(UI_STORAGE_KEYS.DOCKER_INIT_STATUS, {
    state: 'checking',
    message: 'Checking Docker Engine status...',
    hint: 'Please wait while we check the status of the Docker Engine.'
  }));
  readonly isDockerInitializing = computed(() => {
    const state = this.dockerInitStatus().state;
    return (
      state === 'checking' ||
      state === 'detecting-runtime' ||
      state === 'starting-runtime' ||
      state === 'waiting-for-engine'
    );
  });
  readonly dockerErrorStatus = computed(() => {
    const status = this.dockerInitStatus();
    return status.state === 'error' ? status : null;
  });

  private unsubscribeDockerStatus?: () => void;

  readonly navItems = [
    { label: 'Containers', icon: 'deployed_code', route: '/containers' },
    { label: 'Images', icon: 'image', route: '/images' },
    { label: 'Volumes', icon: 'database', route: '/volumes' }
  ];

  ngOnInit(): void {
    this.unsubscribeDockerStatus =
      this.electronApi.onDockerInitializationStatus(status => {
        this.dockerInitStatus.set(status);
        this.sessionStorage.setJson(UI_STORAGE_KEYS.DOCKER_INIT_STATUS, status);
        console.log('Docker initialization status:', status);
        if (status.state === 'ready') {
          this.dockerConnected.set(true);
        }
      });

    this.destroyRef.onDestroy(() => {
      this.unsubscribeDockerStatus?.();
    });

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
}
