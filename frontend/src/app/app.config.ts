import { DatePipe } from '@angular/common';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideCatbeeLoader } from '@ng-catbee/loader';
import { provideCatbeeMonacoEditor } from '@ng-catbee/monaco-editor';

import { routes } from './app.routes';
import { catbeeDarkTheme, catbeeLightTheme } from '@utils/monaco-editor.utils';

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
    }),
    provideCatbeeMonacoEditor({
      baseUrl: 'assets/monaco-editor',
      defaultOptions: {
        theme: 'catbee-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on'
      },
      monacoLoad: async monaco => {
        monaco.editor.defineTheme('catbee-dark', catbeeDarkTheme);
        monaco.editor.defineTheme('catbee-light', catbeeLightTheme);
      }
    })
  ]
};
