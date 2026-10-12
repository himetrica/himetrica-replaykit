import { defineConfig } from "tsup";

// Two builds:
//   "."     ESM + CJS. The ESM build code-splits @rrweb/record into its own chunk,
//           loaded with a dynamic import only once a page may record: a page that
//           only sends signals never downloads rrweb.
//   global  script-tag IIFE, window.ReplayKit with data-* auto-init (rrweb bundled in,
//           an IIFE cannot split).
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    splitting: true,
    target: "es2020",
  },
  {
    entry: { "replaykit.global": "src/global.ts" },
    format: ["iife"],
    minify: true,
    sourcemap: true,
    target: "es2017",
    outExtension: () => ({ js: ".js" }),
  },
]);
