import { DatePipe } from '@angular/common';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [DatePipe, provideBrowserGlobalErrorListeners(), provideRouter(routes, withHashLocation())]
};
