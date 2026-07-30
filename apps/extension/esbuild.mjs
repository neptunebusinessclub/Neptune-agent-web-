import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const watch = process.argv.includes("--watch");
const root = new URL(".", import.meta.url).pathname;
const outdir = path.join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(path.join(root, "static"), outdir, { recursive: true });

const browserNodeBuiltinPlugin = {
  name: "browser-node-builtins",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: "neptune-browser-node-shim"
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "neptune-browser-node-shim" }, (args) => {
      if (args.path === "path") {
        return {
          loader: "js",
          contents: `
            export function basename(value = "") { return String(value).split(/[\\/]/).pop() || ""; }
            export function dirname(value = "") { const parts = String(value).split(/[\\/]/); parts.pop(); return parts.join("/") || "."; }
            export function join(...parts) { return parts.filter(Boolean).join("/").replace(/\\/+/g, "/"); }
            export function resolve(...parts) { return join(...parts); }
            export default { basename, dirname, join, resolve };
          `
        };
      }
      return {
        loader: "js",
        contents: `
          const unavailable = () => { throw new Error("Node fs is unavailable in the Neptune browser runtime"); };
          export const readFile = unavailable;
          export const readFileSync = unavailable;
          export const writeFile = unavailable;
          export const writeFileSync = unavailable;
          export const existsSync = () => false;
          export default { readFile, readFileSync, writeFile, writeFileSync, existsSync };
        `
      };
    });
  }
};

const embeddedPiperRuntimePlugin = {
  name: "embedded-piper-runtime",
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.js$/ }, async (args) => {
      const normalized = args.path.replaceAll("\\", "/");
      if (!normalized.includes("@mintplex-labs/piper-tts-web")) return null;
      let contents = await readFile(args.path, "utf8");
      contents = contents
        .replace(/["']https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/onnxruntime-web\/1\.18\.0\/["']/g, 'new URL("voices/runtime/", self.location.href).href')
        .replace(/["']https:\/\/cdn\.jsdelivr\.net\/npm\/@diffusionstudio\/piper-wasm@1\.0\.0\/build\/piper_phonemize["']/g, 'new URL("voices/runtime/piper_phonemize", self.location.href).href');
      return { loader: "js", contents };
    });
  }
};

const options = {
  entryPoints: {
    "service-worker": path.join(root, "src/service-worker.ts"),
    "content-script": path.join(root, "src/content-script.ts"),
    "sidepanel": path.join(root, "src/sidepanel-entry.ts"),
    "offscreen-wake": path.join(root, "src/offscreen-wake.ts"),
    "webllm-worker": path.join(root, "src/webllm-worker.ts"),
    "piper-voice-worker": path.join(root, "src/piper-voice-worker.ts")
  },
  outdir,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome138",
  sourcemap: watch,
  minify: !watch,
  legalComments: "eof",
  treeShaking: true,
  logLevel: "info",
  plugins: [browserNodeBuiltinPlugin, embeddedPiperRuntimePlugin]
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Neptune extension watch mode enabled");
} else {
  await build(options);
}
