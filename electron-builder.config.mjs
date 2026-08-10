export default {
  appId: 'in.catbee.container.studio',
  productName: 'CatBee Container Studio',
  extraMetadata: {
    main: 'backend/main/main.js'
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
    'package.json',
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
      }
    ]
  },
  mac: {
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
    ],
    hardenedRuntime: true
  },
  linux: {
    target: ['deb', 'zip'],
    category: 'Utility',
    icon: 'assets/icons/linux/catbee-icon.png'
  }
};
