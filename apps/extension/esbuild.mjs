import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const watch = process.argv.includes("--watch");
const root = new URL(".", import.meta.url).pathname;
const outdir = path.join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(path.join(root, "static"), outdir, { recursive: true });

const options = {
  entryPoints: {
    "service-worker": path.join(root, "src/service-worker.ts"),
    "content-script": path.join(root, "src/content-script.ts"),
    "sidepanel": path.join(root, "src/sidepanel.ts")
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome114",
  sourcemap: true,
  logLevel: "info"
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Neptune extension watch mode enabled");
} else {
  await build(options);
}
