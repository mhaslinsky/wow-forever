#!/usr/bin/env node
import { build } from "esbuild";

// The reader is built on the GM's Windows PC, where cmd.exe mangles the quoted
// --banner:js argument the other esbuild scripts pass on the command line.
await build({
  entryPoints: ["src/reader/index.mts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@napi-rs/keyring"],
  outfile: "build/reader/index.mjs",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
