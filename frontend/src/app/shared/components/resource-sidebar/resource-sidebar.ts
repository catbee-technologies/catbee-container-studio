import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild
} from '@angular/core';
import { Router } from '@angular/router';
import { SearchInputComponent } from '@components/search-input/search-input';
import { HintTooltipComponent } from '@components/hint-tooltip/hint-tooltip';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { LocalStorageService } from '@ng-catbee/storage';

export type ResourceStatusType = 'running' | 'paused' | 'not-running' | 'success' | 'warning' | 'info' | 'default';

export interface ResourceSidebarItem {
  id: string;
  name: string;
  subtext?: string;
  statusType?: ResourceStatusType;
  statusLabel?: string;
  tooltip?: string;
}

export interface ResourceSidebarBadge {
  label: string;
  tooltip?: string;
  count?: number;
  indicatorColor?: string;
}

@Component({
  selector: 'catbee-container-studio-resource-sidebar',
  imports: [CommonModule, SearchInputComponent, HintTooltipComponent, CatbeeTooltip],
  templateUrl: './resource-sidebar.html',
  styleUrl: './resource-sidebar.scss',
  host: {
    '[attr.title]': 'null'
  }
})
export class ResourceSidebarComponent {
  private readonly router = inject(Router);
  private readonly localStorage = inject(LocalStorageService);

  readonly title = input.required<string>();
  readonly items = input.required<ResourceSidebarItem[]>();
  readonly activeId = input.required<string>();
  readonly routePrefix = input<string>(''); // e.g. '/containers', '/images', '/volumes', '/networks'
  readonly searchPlaceholder = input<string>('Search...');
  readonly storageKey = input<string>(''); // For persisting collapsed state in localStorage

  readonly isCollapsed = model<boolean>(false);
  readonly badges = input<ResourceSidebarBadge[]>([]);

  readonly itemSelect = output<string>();
  readonly searchQuery = signal('');

  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  private hasInitiallyScrolled = false;

  constructor() {
    effect(() => {
      const activeId = this.activeId();
      const items = this.items();
      if (!activeId || items.length === 0 || this.hasInitiallyScrolled) {
        return;
      }

      // Schedule in next frame after DOM render to ensure item button is placed
      requestAnimationFrame(() => {
        if (!this.hasInitiallyScrolled) {
          this.hasInitiallyScrolled = true;
          this.scrollToActiveItem(activeId);
        }
      });
    });
  }

  private scrollToActiveItem(activeId: string): void {
    const container = this.scrollContainer()?.nativeElement;
    if (!container) {
      return;
    }

    const activeEl = container.querySelector<HTMLElement>(`[data-resource-id="${activeId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  }

  readonly filteredItems = computed(() => {
    const list = this.items();
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) {
      return list;
    }

    return list.filter(item => {
      const name = item.name.toLowerCase();
      const sub = (item.subtext ?? '').toLowerCase();
      const id = item.id.toLowerCase();
      const status = (item.statusLabel ?? '').toLowerCase();
      return name.includes(query) || sub.includes(query) || id.includes(query) || status.includes(query);
    });
  });

  toggleCollapsed(): void {
    const next = !this.isCollapsed();
    this.isCollapsed.set(next);
    const key = this.storageKey();
    if (key) {
      this.localStorage.set(key, next ? 'true' : 'false');
    }
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  selectItem(id: string): void {
    if (id === this.activeId()) {
      return;
    }
    this.itemSelect.emit(id);
    const prefix = this.routePrefix();
    if (prefix) {
      void this.router.navigate([prefix, id]);
    }
  }
}
