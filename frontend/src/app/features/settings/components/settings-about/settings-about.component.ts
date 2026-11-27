import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-about',
  standalone: true,
  imports: [CommonModule, CatbeeTooltip, ErrorBannerComponent],
  templateUrl: './settings-about.component.html',
  styleUrl: './settings-about.component.scss'
})
export class SettingsAboutComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);
}
