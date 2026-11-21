import { InjectionToken } from '@angular/core';
import type { SettingsPageComponent } from '@features/settings/settings-page/settings-page';

export const SETTINGS_PAGE_CONTEXT = new InjectionToken<SettingsPageComponent>('SETTINGS_PAGE_CONTEXT');
