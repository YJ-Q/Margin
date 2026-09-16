function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

// Electron Packager runs every `ignore` regex against a path relative to the
// app root, always prefixed with `/` and normalized to forward slashes on every
// platform (see @electron/packager `dist/copy-filter.js`: `name =
// fullPath.split(path.resolve(opts.dir))[1]`, then `normalizePath` on Windows).
// It supplies e.g. `/test/api.test.js`, never `D:\\Code\\margin\\test\\api.test.js`.
// Anchoring on `^/` therefore excludes only repository-root trees: `/data/...`
// is dropped while `/node_modules/**/data/...` dependency assets are preserved.
function rootRelative(name) {
  return name.split(/[\\/]+/).filter(Boolean).join('/');
}

function projectTree(name) {
  return new RegExp(`^/${escapeRegExp(rootRelative(name))}(?:/|$)`, 'i');
}

function projectFile(name) {
  return new RegExp(`^/${escapeRegExp(rootRelative(name))}$`, 'i');
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
      projectTree('docs/validation'),
      projectTree('docs/superpowers'),
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
