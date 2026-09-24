import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("SourcePanel renders before any debrid file review state exists", async () => {
  const built = await build({
    entryPoints: [path.resolve("components/SourcePanel.js")],
    bundle: true, platform: "node", format: "cjs", write: false,
    jsx: "automatic", loader: { ".js": "jsx" },
    external: ["react", "react-dom", "next/*"],
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url), loadedModule, loadedModule.exports,
  );
  const SourcePanel = loadedModule.exports.default;
  const lookup = { session: null, debridJob: null, debridChoice: null,
    results: [], usenetResults: [], usenetJobs: [], error: "", errorCode: "",
    searching: false, hasSearched: false, usenetEnabled: false };
  const html = renderToStaticMarkup(createElement(SourcePanel, {
    lookup, heading: "Episode", episode: { season: 1, number: 1 },
  }));
  assert.match(html, /Authorized sources/);
});
