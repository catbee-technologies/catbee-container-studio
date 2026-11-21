import { Component, inject, input, model, output } from '@angular/core';
import { FormCheckboxControl } from '@angular/forms/signals';
import { LocalStorageService } from '@ng-catbee/storage';

@Component({
  selector: 'catbee-container-studio-switch-input',
  templateUrl: './switch-input.html',
  styleUrl: './switch-input.scss'
})
export class SwitchInputComponent implements FormCheckboxControl {
  readonly checked = model.required<boolean>();
  readonly label = input<string>();
  /** Id for the inner input, so an external <label for> can toggle it. */
  readonly inputId = input<string>();
  readonly storageKey = input<string>();
  readonly disabled = input(false);
  readonly touch = output<void>();

  private localStorage = inject(LocalStorageService);

  toggleChecked() {
    if (this.disabled()) {
      return;
    }
    this.checked.update(value => {
      const next = !value;
      if (this.storageKey()) {
        this.localStorage.set(this.storageKey()!, next ? 'true' : 'false');
      }
      return next;
    });
  }
}
