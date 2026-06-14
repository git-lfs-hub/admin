#!/usr/bin/env bun
// Guards that dev-only fixture code (dev/*, reachable only from the `if (__DEV__)
// import("@dev/...")` branch) is absent from the worker bundle that gets deployed.
// Runs against the real bundle wrangler emits (build's `--outdir`), not a fresh build.
//
// Marker: `devPresentRepos` is a distinct dev-only name living only in dev/github.ts, so
// its presence in the bundle means the @dev module was actually bundled in. (The inert
// husk esbuild leaves in index.ts references `reconcileLocal`, never this name.)
const file = Bun.argv[2];
if (!file) {
  console.error('usage: assert-no-dev <bundle.js>');
  process.exit(2);
}

const src = await Bun.file(file).text();

const leaked = ['devPresentRepos'].filter((sym) => src.includes(sym));
if (leaked.length) {
  console.error(`✘ dev-only code leaked into deployed bundle ${file}: ${leaked.join(', ')}`);
  process.exit(1);
}

// Sanity: make sure we inspected the actual worker bundle, not an empty/wrong file.
if (!src.includes('discoverRepos')) {
  console.error(`✘ ${file} does not look like the worker bundle (missing real code)`);
  process.exit(1);
}

console.log(`✓ no @dev code in ${file}`);
