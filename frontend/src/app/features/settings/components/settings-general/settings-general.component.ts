import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormField } from '@angular/forms/signals';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { RadioInputComponent } from '@components/radio-input/radio-input';
import { CalloutComponent } from '@components/callout/callout';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-general',
  standalone: true,
  imports: [CommonModule, FormField, SwitchInputComponent, RadioInputComponent, CalloutComponent],
  templateUrl: './settings-general.component.html',
  styleUrl: './settings-general.component.scss'
})
export class SettingsGeneralComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);
}
