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
    target: ['deb', 'zip'],
    category: 'Utility',
    icon: 'assets/icons/linux/catbee-icon.png'
  },
  snapcraft: {
    base: 'core24',
    core24: {
      confinement: 'strict',
      grade: 'stable',
      summary: 'Docker container management desktop application',
      title: 'CatBee Container Studio'
    },
    publish: {
      provider: 'snapStore',
      repo: 'catbee-container-studio'
    }
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'CatBee Container Studio',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false
  }
};
