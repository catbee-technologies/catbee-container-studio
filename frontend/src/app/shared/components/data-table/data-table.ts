import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  contentChild,
  contentChildren,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { LocalStorageService } from '@ng-catbee/storage';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { MenuComponent } from '@components/menu/menu';
import { TableSortHeaderComponent } from '@components/table-sort-header/table-sort-header';
import { SortDirection } from '@shared/types';
import { UI_STORAGE_PREFIX } from '@utils/storage.utils';
import { DataTableColumnDef, DataTableGroupDef, DataTableHeaderDef } from './data-table-defs.directive';
import { DataTableColumn, DataTableGroup, DataTableLayoutState } from './data-table.types';

const DEFAULT_MIN_WIDTH = 60;
const KEYBOARD_RESIZE_STEP = 16;

@Component({
  selector: 'catbee-container-studio-data-table',
  imports: [NgTemplateOutlet, EmptyStateComponent, MenuComponent, TableSortHeaderComponent],
  templateUrl: './data-table.html',
  styleUrl: './data-table.scss'
})
export class DataTableComponent<T, G extends DataTableGroup<T> = DataTableGroup<T>> {
  private readonly localStorage = inject(LocalStorageService);
  private readonly document = inject(DOCUMENT);

  readonly columns = input.required<readonly DataTableColumn[]>();
  readonly rows = input<readonly T[]>([]);
  readonly groups = input<readonly G[] | null>(null);
  readonly storageKey = input<string | null>(null);
  readonly ariaLabel = input('Data table');
  readonly sortKey = input<string | null>(null);
  readonly sortDirection = input<SortDirection>('asc');
  readonly rowKey = input<((row: T) => string) | null>(null);
  readonly rowClass = input<((row: T) => string) | null>(null);
  readonly clickableRows = input(false);
  readonly showColumnPicker = input(true);
  readonly wrapCells = input(true);
  readonly emptyIcon = input('inbox');
  readonly emptyMessage = input('No results.');
  readonly emptyHint = input<string | null>(null);

  readonly sortChange = output<string>();
  readonly rowClick = output<T>();

  private readonly cellDefs = contentChildren<DataTableColumnDef<T>>(DataTableColumnDef, { descendants: true });
  private readonly headerDefs = contentChildren(DataTableHeaderDef, { descendants: true });
  private readonly groupDef = contentChild<DataTableGroupDef<T, G>>(DataTableGroupDef, { descendants: true });

  private readonly tableElement = viewChild<ElementRef<HTMLTableElement>>('tableElement');

  private readonly hiddenColumnIds = signal<ReadonlySet<string>>(new Set<string>());
  private readonly columnWidths = signal<Readonly<Record<string, number>>>({});
  private resizeState: { columnId: string; startX: number; startWidth: number } | null = null;

  readonly showColumnMenu = signal(false);

  readonly visibleColumns = computed(() => {
    const hidden = this.hiddenColumnIds();
    return this.columns().filter(column => !hidden.has(column.id));
  });

  readonly hideableColumns = computed(() => this.columns().filter(column => column.hideable !== false));

  readonly totalColumnCount = computed(() => this.visibleColumns().length + (this.hasFrozenEndColumns() ? 1 : 0));

  readonly nonFrozenEndColumns = computed(() => this.visibleColumns().filter(column => column.frozen !== 'end'));

  readonly frozenEndColumns = computed(() => this.visibleColumns().filter(column => column.frozen === 'end'));

  readonly hasFrozenEndColumns = computed(() => this.frozenEndColumns().length > 0);

  readonly isEmpty = computed(() => {
    const groups = this.groups();
    if (groups) {
      return groups.length === 0;
    }

    return this.rows().length === 0;
  });

  /** Fixed layout is only safe once every visible column has a resolved width. */
  readonly hasFixedLayout = computed(() => {
    const widths = this.columnWidths();
    return this.visibleColumns().every(column => typeof widths[column.id] === 'number');
  });

  readonly totalWidth = computed(() => {
    if (!this.hasFixedLayout()) {
      return null;
    }

    return this.visibleColumns().reduce((sum, column) => sum + (this.columnWidth(column) ?? 0), 0);
  });

  /** Width of the columns frozen to the start, exposed so page content can align with them. */
  readonly frozenStartWidth = computed(() =>
    this.visibleColumns()
      .filter(column => column.frozen === 'start')
      .reduce((sum, column) => sum + (this.columnWidth(column) ?? 0), 0)
  );

  private readonly frozenOffsets = computed(() => {
    const columns = this.visibleColumns();
    const offsets = new Map<string, { side: 'start' | 'end'; offset: number }>();

    let start = 0;
    for (const column of columns) {
      if (column.frozen !== 'start') {
        continue;
      }

      offsets.set(column.id, { side: 'start', offset: start });
      start += this.columnWidth(column) ?? 0;
    }

    let end = 0;
    for (const column of [...columns].reverse()) {
      if (column.frozen !== 'end') {
        continue;
      }

      offsets.set(column.id, { side: 'end', offset: end });
      end += this.columnWidth(column) ?? 0;
    }

    return offsets;
  });

  isFrozen(column: DataTableColumn): boolean {
    return this.frozenOffsets().has(column.id);
  }

  frozenStart(column: DataTableColumn): number | null {
    const entry = this.frozenOffsets().get(column.id);
    return entry?.side === 'start' ? entry.offset : null;
  }

  frozenEnd(column: DataTableColumn): number | null {
    const entry = this.frozenOffsets().get(column.id);
    return entry?.side === 'end' ? entry.offset : null;
  }

  isWrapped(column: DataTableColumn): boolean {
    return column.wrap ?? this.wrapCells();
  }

  constructor() {
    effect(() => {
      const key = this.storageKey();
      const columns = this.columns();
      untracked(() => this.restoreLayout(key, columns));
    });

    afterNextRender(() => this.measureColumnWidths());

    effect(() => {
      this.visibleColumns();
      requestAnimationFrame(() => this.measureColumnWidths());
    });

    // Publishes `--data-table-col-<id>` so page content can align with a column edge.
    effect(() => {
      const table = this.tableElement()?.nativeElement;
      if (!table) {
        return;
      }

      let offset = 0;
      for (const column of this.visibleColumns()) {
        table.style.setProperty(`--data-table-col-${column.id}`, `${offset}px`);
        offset += this.columnWidth(column) ?? 0;
      }
    });
  }

  columnWidth(column: DataTableColumn): number | null {
    return this.columnWidths()[column.id] ?? column.width ?? null;
  }

  cellTemplate(columnId: string) {
    return this.cellDefs().find(def => def.columnId() === columnId)?.template ?? null;
  }

  headerTemplate(columnId: string) {
    return this.headerDefs().find(def => def.columnId() === columnId)?.template ?? null;
  }

  groupTemplate() {
    return this.groupDef()?.template ?? null;
  }

  sortIndicator(column: DataTableColumn): string {
    if (this.sortKey() !== column.id) {
      return 'unfold_more';
    }

    return this.sortDirection() === 'asc' ? 'north' : 'south';
  }

  trackRow(index: number, row: T): string | number {
    return this.rowKey()?.(row) ?? index;
  }

  rowClasses(row: T): string {
    return this.rowClass()?.(row) ?? '';
  }

  isColumnVisible(columnId: string): boolean {
    return !this.hiddenColumnIds().has(columnId);
  }

  toggleColumn(column: DataTableColumn): void {
    if (column.hideable === false) {
      return;
    }

    this.hiddenColumnIds.update(current => {
      const next = new Set(current);
      if (next.has(column.id)) {
        next.delete(column.id);
      } else {
        next.add(column.id);
      }

      return next;
    });

    this.persistLayout();
  }

  resetColumns(): void {
    this.hiddenColumnIds.set(this.defaultHiddenColumnIds(this.columns()));
    this.columnWidths.set({});
    this.persistLayout();
    requestAnimationFrame(() => this.measureColumnWidths());
  }

  toggleColumnMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.showColumnMenu.update(value => !value);
  }

  closeColumnMenu(): void {
    this.showColumnMenu.set(false);
  }

  onRowClick(event: MouseEvent, row: T): void {
    if (!this.clickableRows()) {
      return;
    }

    // Interactive cell content (checkboxes, links, action buttons) handles its own click.
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button, a, input, select, label, [data-row-click-ignore]')) {
      return;
    }

    this.rowClick.emit(row);
  }

  onResizeStart(event: PointerEvent, column: DataTableColumn): void {
    event.preventDefault();
    event.stopPropagation();

    const startWidth = this.columnWidth(column) ?? this.minWidthOf(column);
    this.resizeState = { columnId: column.id, startX: event.clientX, startWidth };

    const onMove = (moveEvent: PointerEvent) => this.applyResize(column, moveEvent.clientX);
    const onEnd = () => {
      this.document.removeEventListener('pointermove', onMove);
      this.document.removeEventListener('pointerup', onEnd);
      this.document.body.classList.remove('is-column-resizing');
      this.resizeState = null;
      this.persistLayout();
    };

    this.document.addEventListener('pointermove', onMove);
    this.document.addEventListener('pointerup', onEnd);
    this.document.body.classList.add('is-column-resizing');
  }

  onResizeKeydown(event: KeyboardEvent, column: DataTableColumn): void {
    const step =
      event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : 0;
    if (step === 0) {
      return;
    }

    event.preventDefault();
    const current = this.columnWidth(column) ?? this.minWidthOf(column);
    this.setColumnWidth(column, current + step);
    this.persistLayout();
  }

  private applyResize(column: DataTableColumn, clientX: number): void {
    const state = this.resizeState;
    if (!state || state.columnId !== column.id) {
      return;
    }

    this.setColumnWidth(column, state.startWidth + (clientX - state.startX));
  }

  private setColumnWidth(column: DataTableColumn, width: number): void {
    const next = Math.max(this.minWidthOf(column), Math.round(width));
    this.columnWidths.update(current => ({ ...current, [column.id]: next }));
  }

  private minWidthOf(column: DataTableColumn): number {
    return column.minWidth ?? DEFAULT_MIN_WIDTH;
  }

  private measureColumnWidths(): void {
    const table = this.tableElement()?.nativeElement;
    if (!table) {
      return;
    }

    const headers = table.querySelectorAll<HTMLTableCellElement>('thead th[data-column-id]');
    const widths = { ...this.columnWidths() };
    let changed = false;

    for (const header of Array.from(headers)) {
      const columnId = header.dataset['columnId'];
      if (!columnId || typeof widths[columnId] === 'number') {
        continue;
      }

      const measured = Math.round(header.getBoundingClientRect().width);
      if (measured > 0) {
        widths[columnId] = measured;
        changed = true;
      }
    }

    if (changed) {
      this.columnWidths.set(widths);
    }
  }

  private defaultHiddenColumnIds(columns: readonly DataTableColumn[]): ReadonlySet<string> {
    return new Set(columns.filter(column => column.defaultVisible === false).map(column => column.id));
  }

  private restoreLayout(storageKey: string | null, columns: readonly DataTableColumn[]): void {
    if (!storageKey) {
      this.hiddenColumnIds.set(this.defaultHiddenColumnIds(columns));
      return;
    }

    const raw = this.localStorage.get(this.layoutStorageKey(storageKey));
    if (!raw) {
      this.hiddenColumnIds.set(this.defaultHiddenColumnIds(columns));
      return;
    }

    const state = this.parseLayout(raw);
    if (!state) {
      this.hiddenColumnIds.set(this.defaultHiddenColumnIds(columns));
      return;
    }

    const knownIds = new Set(columns.map(column => column.id));
    const hideableIds = new Set(columns.filter(column => column.hideable !== false).map(column => column.id));

    this.hiddenColumnIds.set(new Set((state.hidden ?? []).filter(id => hideableIds.has(id))));

    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(state.widths ?? {})) {
      if (knownIds.has(id) && Number.isFinite(width) && width > 0) {
        widths[id] = width;
      }
    }

    this.columnWidths.set(widths);
  }

  private persistLayout(): void {
    const storageKey = this.storageKey();
    if (!storageKey) {
      return;
    }

    const state: DataTableLayoutState = {
      hidden: [...this.hiddenColumnIds()],
      widths: this.columnWidths()
    };

    this.localStorage.set(this.layoutStorageKey(storageKey), JSON.stringify(state));
  }

  private parseLayout(raw: string): DataTableLayoutState | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      return parsed as DataTableLayoutState;
    } catch {
      return null;
    }
  }

  private layoutStorageKey(storageKey: string): string {
    return `${UI_STORAGE_PREFIX}table.${storageKey}.layout`;
  }
}
