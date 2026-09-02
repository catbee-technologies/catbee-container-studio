export interface DataTableColumn {
  readonly id: string;
  readonly label: string;
  readonly sortable?: boolean;
  /** Columns that cannot be hidden from the column picker (checkbox, actions, ...). */
  readonly hideable?: boolean;
  readonly defaultVisible?: boolean;
  readonly resizable?: boolean;
  /** Pins the column to the left or right edge while the table scrolls horizontally. */
  readonly frozen?: 'start' | 'end';
  /** Overrides the table-level `wrapCells` setting for this column. */
  readonly wrap?: boolean;
  readonly width?: number;
  readonly minWidth?: number;
  readonly headerClass?: string;
  readonly cellClass?: string;
}

export interface DataTableGroup<T> {
  readonly id: string;
  readonly rows: readonly T[];
}

export interface DataTableCellContext<T> {
  readonly $implicit: T;
  readonly index: number;
}

export interface DataTableGroupContext<T, G extends DataTableGroup<T>> {
  readonly $implicit: G;
  readonly index: number;
  readonly columnCount: number;
}

export interface DataTableLayoutState {
  readonly hidden?: string[];
  readonly widths?: Record<string, number>;
}
