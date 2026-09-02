import { Directive, TemplateRef, inject, input } from '@angular/core';
import { DataTableCellContext, DataTableGroup, DataTableGroupContext } from './data-table.types';

/** Cell template for a column: `<ng-template catbeeColumnDef="name" let-row>`. */
@Directive({ selector: '[catbeeColumnDef]' })
export class DataTableColumnDef<T> {
  readonly columnId = input.required<string>({ alias: 'catbeeColumnDef' });
  /** Type-inference helper so `let-row` is typed inside the template. */
  readonly rows = input<readonly T[]>([], { alias: 'catbeeColumnDefRows' });

  readonly template = inject<TemplateRef<DataTableCellContext<T>>>(TemplateRef);

  static ngTemplateContextGuard<T>(_dir: DataTableColumnDef<T>, _ctx: unknown): _ctx is DataTableCellContext<T> {
    return true;
  }
}

/** Optional custom header content for a column: `<ng-template catbeeHeaderDef="checkbox">`. */
@Directive({ selector: '[catbeeHeaderDef]' })
export class DataTableHeaderDef {
  readonly columnId = input.required<string>({ alias: 'catbeeHeaderDef' });

  readonly template = inject<TemplateRef<unknown>>(TemplateRef);
}

/** Cells of a group row: `<ng-template catbeeGroupDef let-group>`. */
@Directive({ selector: '[catbeeGroupDef]' })
export class DataTableGroupDef<T, G extends DataTableGroup<T> = DataTableGroup<T>> {
  readonly groups = input<readonly G[]>([], { alias: 'catbeeGroupDefGroups' });

  readonly template = inject<TemplateRef<DataTableGroupContext<T, G>>>(TemplateRef);

  static ngTemplateContextGuard<T, G extends DataTableGroup<T>>(
    _dir: DataTableGroupDef<T, G>,
    _ctx: unknown
  ): _ctx is DataTableGroupContext<T, G> {
    return true;
  }
}
