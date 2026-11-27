import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FormField } from '@angular/forms/signals';
import { TabsComponent } from '@components/tabs/tabs';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { RadioInputComponent } from '@components/radio-input/radio-input';
import { DiscreteSliderComponent } from '@components/discrete-slider/discrete-slider';
import { CalloutComponent } from '@components/callout/callout';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { DropdownComponent, DropdownOption } from '@components/dropdown/dropdown';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-resources',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    FormField,
    TabsComponent,
    SwitchInputComponent,
    RadioInputComponent,
    DiscreteSliderComponent,
    CalloutComponent,
    ErrorBannerComponent,
    DropdownComponent
  ],
  templateUrl: './settings-resources.component.html',
  styleUrl: './settings-resources.component.scss'
})
export class SettingsResourcesComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);

  protected readonly portBindingOptions: readonly DropdownOption<'open' | 'localhost'>[] = [
    { value: 'open', label: 'Open (Default)', description: 'Binds to all interfaces (0.0.0.0 / ::)' },
    { value: 'localhost', label: 'Localhost only', description: 'Restricts published ports to 127.0.0.1' }
  ];

  protected readonly networkingModeOptions: readonly DropdownOption<'ipv4' | 'dualstack'>[] = [
    { value: 'ipv4', label: 'IPv4 only', description: 'Standard IPv4 bridge networking' },
    { value: 'dualstack', label: 'Dual (IPv4 and IPv6)', description: 'Enables IPv6 addressing alongside IPv4' }
  ];
}
