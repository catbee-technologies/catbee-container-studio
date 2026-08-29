/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'in.catbee.container.studio',
  productName: 'CatBee Container Studio',
  artifactName: 'CatBee-Container-Studio-${version}-${os}-${arch}.${ext}',
  extraMetadata: {
    main: 'backend/main/main.js'
  },
  publish: {
    provider: 'github',
    owner: 'catbee-technologies',
    repo: 'catbee-container-studio',
    releaseType: 'draft'
  },
  files: [
    {
      from: 'dist',
      to: 'backend'
    },
    {
      from: 'frontend/dist/catbee-container-studio/browser',
      to: 'app'
    },
    'package.json'
  ],
  directories: {
    output: 'build'
  },
  win: {
    icon: 'assets/icons/windows/catbee-icon.ico',
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      },
      {
        target: 'zip',
        arch: ['x64']
      },
      {
        target: 'msix',
        arch: ['x64']
      }
    ]
  },
  mac: {
    sign: {
      hardenedRuntime: true
    },
    icon: 'assets/icons/macos/catbee-icon.icns',
    target: [
      {
        target: 'dmg',
        arch: 'universal'
      },
      {
        target: 'zip',
        arch: 'universal'
      }
    ]
  },
  linux: {
    target: [
      {
        target: 'deb',
        arch: ['x64']
      },
      {
        target: 'rpm',
        arch: ['x64']
      },
      {
        target: 'AppImage',
        arch: ['x64']
      },
      {
        target: 'tar.gz',
        arch: ['x64']
      }
    ],
    category: 'Utility',
    icon: 'assets/icons/linux/catbee-icon.png'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'CatBee Container Studio',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false
  },
  msix: {
    identityName: 'Catbee.CatbeeContainerStudio',
    publisher: 'CN=3E66AE3B-95DE-4430-827D-87F2A65B8834',
    publisherDisplayName: 'Catbee',
    displayName: 'CatBee Container Studio',
    applicationId: 'CatbeeContainerStudio',
    languages: ['en-US'],
    createMsixupload: true
  },
  snapcraft: {
    base: 'core24',
    core24: {
      useDestructiveMode: true,
      extensions: [],
      confinement: 'strict',
      grade: 'stable',
      summary: 'Docker container management desktop application',
      title: 'CatBee Container Studio'
    },
    publish: {
      provider: 'snapStore',
      repo: 'catbee-container-studio'
    }
  }
};
