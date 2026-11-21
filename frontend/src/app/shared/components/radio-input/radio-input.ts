import { Component, input, output } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-radio-input',
  standalone: true,
  templateUrl: './radio-input.html',
  styleUrl: './radio-input.scss'
})
export class RadioInputComponent {
  /** Name attribute to group radios together */
  readonly name = input<string>();

  /** The value this radio represents */
  readonly value = input<unknown>();

  /** Whether the radio is currently selected */
  readonly checked = input<boolean>(false);

  /** Whether the radio is disabled */
  readonly disabled = input<boolean>(false);

  /** Optional accessible ID for the native input */
  readonly inputId = input<string>();

  /** Emitted when the radio is selected */
  readonly selectChange = output<void>();

  onSelect(): void {
    if (this.disabled()) {
      return;
    }
    this.selectChange.emit();
  }
}
