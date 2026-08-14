import { Component, inject, input, model } from '@angular/core';
import { LocalStorageService } from '@ng-catbee/storage';

@Component({
  selector: 'catbee-container-studio-switch-input',
  templateUrl: './switch-input.html',
  styleUrl: './switch-input.scss'
})
export class SwitchInputComponent {
  readonly checked = model.required<boolean>();
  readonly label = input<string>();
  readonly storageKey = input<string>();

  private localStorage = inject(LocalStorageService);

  toggleChecked() {
    this.checked.update(value => {
      const next = !value;
      if (this.storageKey()) {
        this.localStorage.set(this.storageKey()!, next ? 'true' : 'false');
      }
      return next;
    });
  }
}
