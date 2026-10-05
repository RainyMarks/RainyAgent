const { version } = require('./package.json');

// The bundled NSIS extractor supports BCJ, but not 7-Zip's automatic ARM64 filter.
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';

module.exports = {
  appId: 'dev.rainy.agent', productName: 'RainyAgent',
  publish: { provider: 'github', owner: 'RainyMarks', repo: 'RainyAgent', releaseType: 'release' },
  directories: { app: 'build/shell', output: 'release' },
  files: ['package.json', 'main.cjs', 'preload.cjs', 'setup/**', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '!**/node_modules/**'],
  extraResources: [
    { from: 'resources/strata-runtime', to: 'strata-runtime' },
    { from: 'build/icon.ico', to: 'icon.ico' },
    { from: 'runtime/linux-runtime.tar.gz', to: 'linux-runtime.tar.gz' },
    { from: 'runtime/linux-runtime.json', to: 'linux-runtime.json' },
    { from: 'scripts/install-runtime.py', to: 'install-runtime.py' },
    { from: 'runtime/release-public-keys.json', to: 'release-public-keys.json' },
    { from: 'runtime/environment-component-catalog.json', to: 'environment-component-catalog.json' },
    { from: 'scripts/install-environment-component.py', to: 'install-environment-component.py' },
    { from: `release/offline-${version}/native-tools-metadata.json`, to: 'native-tools-metadata.json' },
  ],
  npmRebuild: false,
  afterPack: './scripts/after-pack.cjs',
  asar: true,
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/icon.ico', signExecutable: Boolean(process.env.CSC_LINK) },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, shortcutName: 'RainyAgent', deleteAppDataOnUninstall: false, include: 'resources/native-tools-installer.nsh' },
  artifactName: 'RainyAgent-${version}-windows-x64-setup.${ext}',
};
