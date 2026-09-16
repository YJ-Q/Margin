const path = require('node:path');

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

// Electron Packager applies `ignore` to every source path, including nested
// dependency assets.  Scope generated-tree exclusions to this repository so,
// for example, node_modules/**/data/*.json remains available at runtime.
function projectTree(name) {
  return new RegExp(`^${escapeRegExp(path.join(__dirname, name))}(?:[\\\\/]|$)`, 'i');
}

function projectFile(name) {
  return new RegExp(`^${escapeRegExp(path.join(__dirname, name))}$`, 'i');
}

module.exports = {
  // Keep Squirrel's staging tree below the Windows legacy MAX_PATH limit.
  outDir: 'out2',
  packagerConfig: {
    asar: true,
    // Never recursively package prior Forge outputs or local smoke logs.
    ignore: [
      projectTree('.worktrees'),
      projectTree('handoff-output'),
      // Match only Forge's output dirs (out, out2, ...). Do NOT broaden to
      // `out[^\\/]*` — that also matches node_modules/semver/ranges/outside.js,
      // breaking prebuild-install and forcing a node-gyp rebuild (needs Python).
      projectTree('out'),
      projectTree('out2'),
      projectFile('electron-main.log'),
      // S5A packaging hygiene. The packaged app runs on its bundled Electron
      // node and writes every mutable artifact (Core DB, captured-session
      // snapshots, telemetry) under app.getPath('userData')/margin-runtime, never
      // the repo tree (see electron/main.js `runtimeRoot`). Excluding these
      // dev/generated trees keeps the .asar small without affecting the app.
      projectTree('.runtime'),
      projectTree('.margin'),
      projectTree('.superpowers'),
      projectTree('.claude'),
      projectTree('.agents'),
      projectTree('data'),
      projectTree('design-references'),
      projectTree('experiments'),
      projectTree(path.join('docs', 'validation')),
      projectTree(path.join('docs', 'superpowers')),
      projectTree('test'),
      projectTree('evaluation')
    ],
    // Copy the built surface beneath resources/web so Electron can resolve
    // resources/web/dist without relying on the shell working directory.
    extraResource: ['web'],
  },
  // Prefer maintained prebuilds; do not require a global Python/MSVC toolchain
  // just to package better-sqlite3 for this host.
  rebuildConfig: { force: false },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'margin', authors: 'Margin', description: 'Margin floating host' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
  ],
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
  ],
};
