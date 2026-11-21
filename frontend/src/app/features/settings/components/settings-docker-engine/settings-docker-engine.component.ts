import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { JsonViewerComponent } from '@components/json-viewer/json-viewer';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { ExpansionCardComponent } from '@components/expansion-card/expansion-card';
import { CalloutComponent } from '@components/callout/callout';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { CatbeeLoaderComponent } from '@ng-catbee/loader';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';

@Component({
  selector: 'catbee-settings-docker-engine',
  standalone: true,
  imports: [
    CommonModule,
    JsonViewerComponent,
    CatbeeTooltip,
    ErrorBannerComponent,
    ExpansionCardComponent,
    CalloutComponent,
    CopyButtonComponent,
    CatbeeLoaderComponent
  ],
  templateUrl: './settings-docker-engine.component.html',
  styleUrl: './settings-docker-engine.component.scss'
})
export class SettingsDockerEngineComponent {
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);
}
