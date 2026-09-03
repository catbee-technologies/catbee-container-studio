import { DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { LocalStorageService } from '@ng-catbee/storage';
import { UI_STORAGE_KEYS } from '@utils/storage.utils';

export enum AppTheme {
  DARK = 'dark',
  LIGHT = 'light'
}

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private static readonly HIGHLIGHT_THEME_LINK_ID = 'catbee-highlight-theme';
  private readonly document = inject(DOCUMENT);
  private readonly localStorage = inject(LocalStorageService);

  readonly isDeviceDefaultTheme = signal(true);
  readonly currentTheme = signal<AppTheme>(AppTheme.DARK);
  readonly isLightMode = signal(false);

  constructor() {
    this.initialize();
  }

  initialize() {
    const isDeviceDefault = this.localStorage.getBooleanWithDefault(UI_STORAGE_KEYS.IS_DEFAULT_THEME, true) === true;
    const storedTheme = this.localStorage.getEnumWithDefault<AppTheme>(UI_STORAGE_KEYS.THEME, AppTheme.DARK, [
      AppTheme.DARK,
      AppTheme.LIGHT
    ]);

    const theme = isDeviceDefault ? this.preferredTheme : storedTheme;

    this.isDeviceDefaultTheme.set(isDeviceDefault);
    this.applyTheme(theme);
  }

  get preferredTheme(): AppTheme {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? AppTheme.DARK : AppTheme.LIGHT;
  }

  toggleTheme() {
    this.setTheme(this.currentTheme() === AppTheme.DARK ? AppTheme.LIGHT : AppTheme.DARK);
  }

  setTheme(theme: AppTheme) {
    if (!Object.values(AppTheme).includes(theme)) {
      theme = AppTheme.DARK;
    }
    this.applyTheme(theme);
    this.persistTheme(theme, false);
  }

  toggleToDarkTheme() {
    this.applyTheme(AppTheme.DARK);
    this.persistTheme(AppTheme.DARK, false);
  }

  toggleToLightTheme() {
    this.applyTheme(AppTheme.LIGHT);
    this.persistTheme(AppTheme.LIGHT, false);
  }

  toggleToDeviceDefaultTheme() {
    const theme = this.preferredTheme;
    this.applyTheme(theme);
    this.persistTheme(theme, true);
  }

  private applyTheme(theme: AppTheme) {
    const isLight = theme === AppTheme.LIGHT;

    this.document.documentElement.setAttribute('data-theme', theme);
    this.document.documentElement.classList.toggle('theme-dark', !isLight);
    this.document.documentElement.classList.toggle('theme-light', isLight);
    this.applyHighlightTheme(isLight);

    this.currentTheme.set(theme);
    this.isLightMode.set(isLight);
  }

  private applyHighlightTheme(isLight: boolean) {
    let themeLink = this.document.getElementById(ThemeService.HIGHLIGHT_THEME_LINK_ID) as HTMLLinkElement | null;

    if (!themeLink) {
      themeLink = this.document.createElement('link');
      themeLink.id = ThemeService.HIGHLIGHT_THEME_LINK_ID;
      themeLink.rel = 'stylesheet';
      this.document.head.append(themeLink);
    }

    themeLink.href = `assets/highlight.js/${isLight ? 'vs.css' : 'vs-dark.css'}`;
  }

  private persistTheme(theme: AppTheme, isDeviceDefault: boolean) {
    this.localStorage.set(UI_STORAGE_KEYS.THEME, theme);
    this.localStorage.set(UI_STORAGE_KEYS.IS_DEFAULT_THEME, isDeviceDefault.toString());
    this.isDeviceDefaultTheme.set(isDeviceDefault);
  }
}
