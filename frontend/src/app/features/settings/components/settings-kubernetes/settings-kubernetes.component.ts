import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SwitchInputComponent } from '@components/switch-input/switch-input';
import { DropdownComponent } from '@components/dropdown/dropdown';
import { DiscreteSliderComponent } from '@components/discrete-slider/discrete-slider';
import { TableCheckboxComponent } from '@components/table-checkbox/table-checkbox';
import { CalloutComponent } from '@components/callout/callout';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { K8sIconComponent } from '@shared/components/k8s-icon/k8s-icon.component';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-kubernetes',
  standalone: true,
  imports: [
    CommonModule,
    SwitchInputComponent,
    DropdownComponent,
    DiscreteSliderComponent,
    TableCheckboxComponent,
    CalloutComponent,
    ErrorBannerComponent,
    K8sIconComponent
  ],
  templateUrl: './settings-kubernetes.component.html',
  styleUrl: './settings-kubernetes.component.scss'
})
export class SettingsKubernetesComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);
}
