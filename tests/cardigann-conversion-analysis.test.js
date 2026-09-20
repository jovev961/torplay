import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";
import {
  analyzeCardigannConversion,
  summarizeConversionAnalysis,
} from "../scripts/lib/cardigann-conversion-analysis.js";

const executeFile = promisify(execFile);

function sourceDefinition(overrides = {}) {
  return {
    id: "neutral-source",
    name: "Neutral Source",
    description: "Provider-neutral conversion analysis fixture",
    language: "en-US",
    type: "public",
    encoding: "UTF-8",
    links: ["https://source.example/"],
    caps: {
      categories: { "1": "Movies", "2": "TV" },
      modes: { search: ["q"], "movie-search": ["q"], "tv-search": ["q", "season", "ep"] },
    },
    settings: [],
    search: {
      paths: [{ path: "/search" }],
      inputs: { q: "{{ .Keywords }}" },
      keywordsfilters: [{ name: "replace", args: [".", " "] }],
      rows: { selector: ".result" },
      fields: {
        category: { text: "1" },
        title: { selector: ".title" },
        size: { selector: ".size", filters: [{ name: "trim" }] },
        seeders: { selector: ".seeders" },
        magnet: { selector: "a", attribute: "href" },
      },
    },
    ...overrides,
  };
}

test("minimal conversion analysis accepts provider-neutral HTML and JSON definitions", () => {
  const html = analyzeCardigannConversion(sourceDefinition());
  const json = analyzeCardigannConversion(sourceDefinition({
    search: {
      paths: [{ path: "/api/search", response: { type: "json" } }],
      inputs: { q: "{{ .Query.Q }}" },
      rows: { selector: "items" },
      fields: {
        title: { selector: "name" },
        infohash: { selector: "hash" },
        seeders: { selector: "seeders" },
      },
    },
  }));

  assert.deepEqual(html, { modelVersion: 1, convertible: true, responseTypes: ["html"], blockers: [] });
  assert.deepEqual(json, { modelVersion: 1, convertible: true, responseTypes: ["json"], blockers: [] });
});

test("conversion analysis reports every advanced Cardigann feature with its path", () => {
  const definition = analyzeCardigannConversion(sourceDefinition({
    type: "private",
    encoding: "ISO-8859-1",
    followredirect: false,
    requestDelay: 2,
    login: { method: "cookie", inputs: { cookie: "{{ .Config.cookie }}" } },
    download: { selectors: [{ selector: "a", attribute: "href" }] },
    search: {
      paths: [{
        path: "/search",
        method: "{{ if .Keywords }}post{{ else }}get{{ end }}",
        inputs: { $raw: "q={{ .Keywords }}" },
        response: { type: "xml", noResultsMessage: "none" },
      }],
      headers: { Authorization: "Bearer {{ .Config.token }}" },
      inputs: { $raw: "category=1" },
      rows: { selector: "item", count: { selector: "count" } },
      fields: { title: { selector: "title", case: { "*": "{{ .Result.title }}" } } },
    },
  }));

  const byFeature = new Map(definition.blockers.map((blocker) => [blocker.feature, blocker]));
  assert.equal(definition.convertible, false);
  for (const feature of [
    "access", "login", "download", "request-delay", "redirect-policy", "encoding",
    "search-option", "raw-inputs", "dynamic-method", "response-option", "response-type",
    "row-option", "field-option", "template",
  ]) assert.equal(byFeature.has(feature), true, `missing ${feature}`);
  assert.equal(byFeature.get("dynamic-method").path, "definition.search.paths[0].method");
  assert.equal(byFeature.get("response-type").path, "definition.search.paths[0].response.type");
  assert.match(byFeature.get("template").message, /requires the Cardigann runtime/);
});

test("conversion summaries count blocker features once per definition", () => {
  const compatible = analyzeCardigannConversion(sourceDefinition());
  const incompatible = analyzeCardigannConversion(sourceDefinition({
    type: "private",
    search: {
      paths: [{ path: "{{ if .Keywords }}/search{{ else }}/latest{{ end }}" }],
      inputs: { q: "{{ if .Keywords }}{{ .Keywords }}{{ end }}" },
      rows: { selector: ".result" },
      fields: { title: { selector: ".title" }, magnet: { selector: "a", attribute: "href" } },
    },
  }));
  assert.deepEqual(summarizeConversionAnalysis([
    { analysis: compatible }, { analysis: incompatible },
  ]), {
    modelVersion: 1,
    analyzed: 2,
    convertible: 1,
    incompatible: 1,
    responseTypes: { html: 2 },
    blockerDefinitions: { access: 1, template: 1 },
  });
});

test("audit CLI exposes conversion analysis without changing normal compatibility", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-conversion-audit-"));
  try {
    const html = sourceDefinition();
    const xml = sourceDefinition({
      id: "neutral-feed",
      name: "Neutral Feed",
      search: {
        paths: [{ path: "/feed", response: { type: "xml" } }],
        inputs: { q: "{{ .Keywords }}" },
        rows: { selector: "item" },
        fields: {
          category: { text: "1" },
          title: { selector: "title" },
          download: { selector: "link" },
          size: { text: "1 MB" },
          seeders: { text: "1" },
        },
      },
    });
    await Promise.all([
      writeFile(path.join(directory, "html.yml"), stringify(html)),
      writeFile(path.join(directory, "xml.yml"), stringify(xml)),
    ]);
    const { stdout } = await executeFile(process.execPath, [
      "scripts/audit-cardigann-definitions.js", directory, "--conversion-analysis", "--details",
    ], { cwd: process.cwd() });
    const report = JSON.parse(stdout);
    assert.equal(report.compatible, 2);
    assert.equal(report.conversionAnalysis.convertible, 1);
    assert.equal(report.conversionAnalysis.incompatible, 1);
    assert.equal(report.conversionAnalysis.blockerDefinitions["response-type"], 1);
    assert.equal(report.definitions.compatible.find((item) => item.id === "neutral-feed").conversion.convertible, false);

    const normal = JSON.parse((await executeFile(process.execPath, [
      "scripts/audit-cardigann-definitions.js", directory, "--details",
    ], { cwd: process.cwd() })).stdout);
    assert.equal(Object.hasOwn(normal, "conversionAnalysis"), false);
    assert.equal(Object.hasOwn(normal.definitions.compatible[0], "conversion"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
