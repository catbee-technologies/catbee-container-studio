import { CommonModule } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { timer, exhaustMap, from, catchError, of } from 'rxjs';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet
} from '@angular/router';
import { WindowHeaderComponent } from '@components/window-header/window-header';
import { DockerApiService } from '@core/docker-api.service';
import { LocalStorageService, SessionStorageService } from '@ng-catbee/storage';
import { CatbeeLoaderComponent, CatbeeLoaderService } from '@ng-catbee/loader';
import { UI_STORAGE_DEFAULTS, UI_STORAGE_KEYS } from '@shared/utils/storage.utils';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { ElectronApiService } from '@core/electron-api.service';
import { DockerInitializationStatus } from '@shared/types';
import { FooterComponent } from '@components/footer/footer';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

@Component({
  selector: 'catbee-container-studio-root',
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    WindowHeaderComponent,
    EmptyStateComponent,
    FooterComponent,
    CatbeeTooltip,
    CatbeeLoaderComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly localStorage = inject(LocalStorageService);
  private readonly sessionStorage = inject(SessionStorageService);
  private readonly dockerApi = inject(DockerApiService);
  private readonly electronApi = inject(ElectronApiService);
  private readonly router = inject(Router);
  private readonly loader = inject(CatbeeLoaderService);
  private readonly destroyRef = inject(DestroyRef);
  private navigationLoaderTimeout: ReturnType<typeof setTimeout> | null = null;

  readonly NAVIGATION_LOADER_NAME = 'catbee-navigation-loader';
  readonly NAVIGATION_LOADER_DELAY_MS = 150; // Delay before showing the loader (in milliseconds)

  readonly sidebarCollapsed = signal(
    this.localStorage.getBooleanWithDefault(UI_STORAGE_KEYS.SIDEBAR_COLLAPSED, UI_STORAGE_DEFAULTS.SIDEBAR_COLLAPSED)
  );
  readonly dockerConnected = signal(true); // Assume connected until checked
  readonly dockerInitStatus = signal<DockerInitializationStatus>(
    this.sessionStorage.getJsonWithDefault<DockerInitializationStatus>(UI_STORAGE_KEYS.DOCKER_INIT_STATUS, {
      state: 'checking',
      message: 'Checking Docker Engine status...',
      hint: 'Please wait while we check the status of the Docker Engine.'
    })
  );
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
    { label: 'Volumes', icon: 'database', route: '/volumes' },
    { label: 'Networks', icon: 'lan', route: '/networks' },
    { label: 'Logs', icon: 'article', route: '/logs' }
  ];

  ngOnInit(): void {
    this.unsubscribeDockerStatus = this.electronApi.onDockerInitializationStatus(status => {
      this.dockerInitStatus.set(status);
      this.sessionStorage.setJson(UI_STORAGE_KEYS.DOCKER_INIT_STATUS, status);
      console.log(`\x1b[36m${new Date().toISOString()}\x1b[0m Docker initialization status:`, status);
      if (status.state === 'ready') {
        this.dockerConnected.set(true);
      }
    });

    this.electronApi.notifyDockerRendererReady();

    this.destroyRef.onDestroy(() => {
      this.unsubscribeDockerStatus?.();
    });

    timer(0, 5000)
      .pipe(
        exhaustMap(() => from(this.dockerApi.pingDockerEngine()).pipe(catchError(() => of(false)))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(isConnected => {
        console.log(`Docker connected: ${isConnected ? '\x1b[32mtrue' : '\x1b[31mfalse'}\x1b[0m`);
        this.dockerConnected.set(isConnected);
      });

    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event instanceof NavigationStart) {
        // Only show the loader if the navigation (e.g. a resolver) takes a noticeable amount of time.
        this.navigationLoaderTimeout = setTimeout(() => {
          void this.loader.show(this.NAVIGATION_LOADER_NAME, {
            message: 'Loading...',
            fullscreen: false,
            loaderColor: 'var(--color-loader)',
            backgroundColor: 'var(--bg-loader)',
            size: 'default'
          });
        }, this.NAVIGATION_LOADER_DELAY_MS);
        return;
      }

      if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
        if (this.navigationLoaderTimeout) {
          clearTimeout(this.navigationLoaderTimeout);
          this.navigationLoaderTimeout = null;
        }
        void this.loader.hide(this.NAVIGATION_LOADER_NAME);
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.navigationLoaderTimeout) {
        clearTimeout(this.navigationLoaderTimeout);
      }
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
