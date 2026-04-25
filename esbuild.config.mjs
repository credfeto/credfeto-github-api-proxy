import { build } from "esbuild";
import { rmSync, mkdirSync } from "fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "dist/index.js",
  format: "cjs",
  minify: true,
  // Nothing is external — bundle express, dotenv, everything into one file.
  // The only things we can't bundle are native .node addons, but none are used here.
});

console.log("Build complete: dist/index.js");
