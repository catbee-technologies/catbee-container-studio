import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CatbeeLoaderComponent } from '@ng-catbee/loader';
import { CalloutComponent } from '@shared/components/callout/callout';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-troubleshoot',
  standalone: true,
  imports: [CommonModule, CatbeeLoaderComponent, CalloutComponent],
  templateUrl: './settings-troubleshoot.component.html',
  styleUrl: './settings-troubleshoot.component.scss'
})
export class SettingsTroubleshootComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);
}
