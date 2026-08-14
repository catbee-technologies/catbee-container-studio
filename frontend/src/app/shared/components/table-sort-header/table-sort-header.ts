import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-table-sort-header',
  imports: [CommonModule],
  templateUrl: './table-sort-header.html',
  styleUrl: './table-sort-header.scss'
})
export class TableSortHeaderComponent {
  readonly label = input.required<string>();
  readonly active = input(false);
  readonly indicator = input('unfold_more');

  readonly sort = output<void>();

  onSort(): void {
    this.sort.emit();
  }
}
