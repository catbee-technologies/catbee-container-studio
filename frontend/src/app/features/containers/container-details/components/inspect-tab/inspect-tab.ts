import { Component, input, viewChild } from '@angular/core';
import { JsonViewerComponent } from '@components/json-viewer/json-viewer';
import { DockerContainerInspectInfo } from '@shared/types/docker-api.types';

@Component({
  selector: 'catbee-container-studio-container-inspect-tab',
  imports: [JsonViewerComponent],
  templateUrl: './inspect-tab.html',
  styleUrl: './inspect-tab.scss'
})
export class InspectTabComponent {
  private readonly jsonViewer = viewChild<JsonViewerComponent>('jsonViewer');

  readonly inspectData = input<DockerContainerInspectInfo | null>(null);

  focusAndSelectSearch(): void {
    this.jsonViewer()?.focusAndSelectSearch();
  }
}
