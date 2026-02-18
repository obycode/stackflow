import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const entry = path.resolve(root, "server/ui/main.src.js");
const outfile = path.resolve(root, "server/ui/main.js");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

console.log(`[build-ui] bundled ${path.relative(root, entry)} -> ${path.relative(root, outfile)}`);
