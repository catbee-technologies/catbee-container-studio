import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-table-checkbox',
  imports: [CommonModule],
  templateUrl: './table-checkbox.html',
  styleUrl: './table-checkbox.scss'
})
export class TableCheckboxComponent {
  readonly checked = input(false);
  readonly indeterminate = input(false);
  readonly size = input<'small' | 'medium' | 'large'>('medium');
  readonly ariaLabel = input('Select row');

  readonly checkedChange = output<void>();

  onChange(): void {
    this.checkedChange.emit();
  }
}
