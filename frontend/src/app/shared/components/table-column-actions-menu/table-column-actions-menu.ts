import { Component, inject, input, model, output, signal } from '@angular/core';
import { MenuComponent } from '@components/menu/menu';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { LocalStorageService } from '@ng-catbee/storage';

export interface ColumnOption<T extends string = string> {
  key: T;
  label: string;
}

@Component({
  selector: 'catbee-container-studio-table-column-actions-menu',
  templateUrl: './table-column-actions-menu.html',
  styleUrls: ['./table-column-actions-menu.scss'],
  imports: [MenuComponent, CatbeeTooltip, TableCheckboxComponent]
})
export class TableColumnActionsMenuComponent<T extends string = string> {
  private readonly localStorage = inject(LocalStorageService);

  readonly columns = input.required<ColumnOption<T>[]>();
  readonly defaultVisible = input.required<T[]>();
  readonly requiredColumns = input<T[]>([]);
  readonly storageKey = input.required<string>();
  readonly tooltipDelay = input(0);
  readonly style = input<Record<string, string>>({ width: '14rem' });

  readonly showSelectAll = input(true);
  readonly showRemoveAll = input(true);
  readonly showReset = input(true);

  readonly dismissed = output<void>();

  readonly open = signal(false);
  readonly visibleColumns = model<Set<T>>(new Set());

  toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.open.update(value => !value);
  }

  isVisible(column: T): boolean {
    return this.visibleColumns().has(column);
  }

  toggle(column: T): void {
    this.visibleColumns.update(current => {
      const next = new Set(current);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      this.save(next);
      return next;
    });
  }

  selectAll(): void {
    const next = new Set(this.columns().map(column => column.key));
    for (const column of this.requiredColumns()) {
      next.add(column);
    }
    this.visibleColumns.set(next);
    this.save(next);
  }

  removeAll(): void {
    const next = new Set<T>();
    for (const column of this.requiredColumns()) {
      next.add(column);
    }
    this.visibleColumns.set(next);
    this.save(next);
  }

  reset(): void {
    const next = new Set(this.defaultVisible());
    this.visibleColumns.set(next);
    this.save(next);
  }

  private save(columns: Set<T>): void {
    this.localStorage.setArray<T>(this.storageKey(), [...columns]);
  }
}
