import config from './electron-builder.config.mjs';

/** @type {import('electron-builder').Configuration} */
export default {
  ...config,
  win: {
    ...config.win,
    target: [
      {
        target: 'msix',
        arch: ['x64']
      }
    ]
  },
  msix: {
    identityName: 'Catbee.CatbeeContainerStudio',
    publisher: 'CN=3E66AE3B-95DE-4430-827D-87F2A65B8834',
    publisherDisplayName: 'Catbee',
    displayName: 'CatBee Container Studio',
    applicationId: 'CatbeeContainerStudio',
    languages: ['en-US'],
    createMsixupload: true
  }
};
