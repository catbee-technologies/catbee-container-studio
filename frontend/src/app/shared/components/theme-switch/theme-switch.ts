import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ThemeService } from '@services/theme.service';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';

@Component({
  selector: 'catbee-container-studio-theme-switch',
  imports: [CommonModule, CatbeeTooltip],
  templateUrl: './theme-switch.html',
  styleUrl: './theme-switch.scss'
})
export class ThemeSwitchComponent {
  private readonly themeService = inject(ThemeService);

  readonly lightMode = computed(() => this.themeService.isLightMode());
  readonly isDeviceDefault = computed(() => this.themeService.isDeviceDefaultTheme());

  toggleTheme(): void {
    if (this.isDeviceDefault()) {
      this.themeService.toggleToLightTheme();
    } else if (this.lightMode()) {
      this.themeService.toggleToDarkTheme();
    } else {
      this.themeService.toggleToDeviceDefaultTheme();
    }
  }
}
