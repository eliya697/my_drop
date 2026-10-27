import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled into the worker. Third-party
// dependencies stay external and are installed in the runtime image.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@dropship\//],
  // Any other bare import (including dependencies of workspace packages, e.g. pino via
  // @dropship/logger) stays external: CJS packages break when inlined into an ESM bundle.
  external: [/^(?!@dropship\/)[^./]/],
});
