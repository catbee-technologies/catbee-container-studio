import { DatePipe } from '@angular/common';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideCatbeeLoader } from '@ng-catbee/loader';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    DatePipe,
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    provideCatbeeLoader({
      animation: 'ball-spin-clockwise',
      size: 'medium',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      loaderColor: '#ffffff',
      zIndex: 999999
    })
  ]
};
