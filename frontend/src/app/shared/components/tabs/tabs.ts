import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
}

@Component({
  selector: 'catbee-container-studio-tabs',
  imports: [CommonModule],
  templateUrl: './tabs.html',
  styleUrl: './tabs.scss'
})
export class TabsComponent {
  readonly tabs = input.required<readonly TabItem[]>();
  readonly activeTab = input.required<string>();
  readonly ariaLabel = input.required<string>();

  readonly activeTabChange = output<string>();

  selectTab(tabId: string): void {
    this.activeTabChange.emit(tabId);
  }
}
