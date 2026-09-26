import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const built = await build({
  entryPoints: [path.resolve("components/DebridLibraryFileRow.js")],
  bundle: true, platform: "node", format: "cjs", write: false,
  jsx: "automatic", loader: { ".js": "jsx" }, external: ["react", "react-dom"],
});
const loadedModule = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loadedModule, loadedModule.exports,
);
const DebridLibraryFileRow = loadedModule.exports.default;
const file = { providerId: "1", name: "Example.S01E01.mkv", size: 1024, selected: true };

function render(props = {}) {
  return renderToStaticMarkup(createElement(DebridLibraryFileRow, {
    file, mappings: [], isShow: true, ready: true, playing: false, editing: false,
    mapSeason: 1, mapEpisode: 1, mappingBusy: false, mappingError: "",
    onEdit() {}, onCancel() {}, onMap() {}, onPlay() {}, onSeasonChange() {}, onEpisodeChange() {},
    ...props,
  }));
}

test("show file row explains missing mapping and offers a map action", () => {
  const html = render();
  assert.match(html, /debridLibraryUnmapped[^>]*>Not mapped/);
  assert.match(html, /Choose an episode to enable direct playback/);
  assert.match(html, />Map episode<\/button>/);
  assert.match(html, />Play<\/button>/);
});

test("mapped playing row shows episode and a change action", () => {
  const html = render({ mappings: [{ season: 1, episode: 2 }], playing: true });
  assert.match(html, /debridLibraryMapped[^>]*>Mapped to S01E02/);
  assert.match(html, />Change mapping<\/button>/);
  assert.match(html, />Play again<\/button>/);
  assert.match(html, /debridLibraryFilePlaying[^>]*>Playing/);
  assert.doesNotMatch(html, /Not mapped/);
});

test("mapping editor explains replacement and keeps errors beside the file", () => {
  const html = render({ mappings: [{ season: 1, episode: 2 }], editing: true,
    mapEpisode: 3, mappingError: "This episode is already mapped." });
  assert.match(html, /Saving replaces this file’s current episode assignments/);
  assert.match(html, /value="3"/);
  assert.match(html, /role="alert">This episode is already mapped/);
});

test("movie file has no episode mapping controls", () => {
  const html = render({ isShow: false });
  assert.doesNotMatch(html, /Mapped|Not mapped|Map episode|Change mapping/);
  assert.match(html, />Play<\/button>/);
});

test("file rows show inferred HDR and Dolby formats", () => {
  const html = render({
    file: { providerId: "2", name: "Movie.2160p.DV.HDR10.HEVC.TrueHD.Atmos.mkv",
      size: 1024, selected: true },
    isShow: false,
  });
  assert.match(html, /Dolby Vision/);
  assert.match(html, /HDR10/);
  assert.match(html, /HEVC \/ H\.265/);
  assert.match(html, /TrueHD/);
  assert.match(html, /Atmos/);
});
