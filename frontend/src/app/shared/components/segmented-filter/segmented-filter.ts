import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';

export interface SegmentedFilterOption {
  readonly value: string;
  readonly label: string;
}

@Component({
  selector: 'catbee-container-studio-segmented-filter',
  imports: [CommonModule],
  templateUrl: './segmented-filter.html',
  styleUrl: './segmented-filter.scss'
})
export class SegmentedFilterComponent {
  readonly ariaLabel = input.required<string>();
  readonly options = input<readonly SegmentedFilterOption[]>([]);
  readonly activeValue = input('');

  readonly valueChange = output<string>();

  onSelect(value: string): void {
    this.valueChange.emit(value);
  }
}
