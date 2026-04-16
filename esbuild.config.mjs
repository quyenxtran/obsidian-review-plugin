import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: prod ? false : "inline",
  minify: prod,
  logLevel: "info",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ]
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
}

await context.watch();
console.log("Watching for changes...");

