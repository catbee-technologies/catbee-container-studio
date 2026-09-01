import { MonacoEditorCustomThemeData } from '@ng-catbee/monaco-editor';

const darkBackground = '#0d1117';

export const catbeeDarkTheme: MonacoEditorCustomThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    {
      background: darkBackground,
      token: ''
    }
  ],
  colors: {
    'editor.background': darkBackground
  }
};

export const catbeeLightTheme: MonacoEditorCustomThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    {
      background: '#FFFFFF',
      token: ''
    }
  ],
  colors: {
    'editor.background': '#FFFFFF'
  }
};
