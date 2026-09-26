import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const built = await build({
  entryPoints: [path.resolve("components/ReadyEpisodes.js")],
  bundle: true, platform: "node", format: "cjs", write: false,
  jsx: "automatic", loader: { ".js": "jsx" }, external: ["react", "react-dom"],
});
const loadedModule = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loadedModule, loadedModule.exports,
);
const ReadyEpisodes = loadedModule.exports.default;
const { shouldShowReadyEpisodes } = loadedModule.exports;

const episodes = [10, 2, 1, 11, 3, 5, 4, 6].map((episode) => ({
  season: 1, episode, provider: "real-debrid",
})).concat([{ season: 2, episode: 3, provider: "torbox" },
  { season: 2, episode: 1, provider: "torbox" }]);

function render(props) {
  return renderToStaticMarkup(createElement(ReadyEpisodes, {
    seasonNumber: 1, episodes, ...props,
  }));
}

test("ready cards sort by numeric episode and keep Playing in position", () => {
  const html = render({ playing: { season: 1, episode: 5 } });
  const codes = [...html.matchAll(/S01E\d{2}/g)].map((match) => match[0]);
  assert.deepEqual(codes, ["S01E01", "S01E02", "S01E03", "S01E04", "S01E05",
    "S01E06", "S01E10", "S01E11"]);
  assert.doesNotMatch(html, /S02E/);
  assert.match(html, /S01E05[^<]*<\/strong><span class="playingBadge">Playing<\/span>/);
});

test("ready cards filter another season and show an empty state", () => {
  const second = render({ seasonNumber: 2 });
  assert.deepEqual([...second.matchAll(/S02E\d{2}/g)].map((match) => match[0]),
    ["S02E01", "S02E03"]);
  assert.doesNotMatch(second, /S01E/);
  const empty = render({ seasonNumber: 3 });
  assert.match(empty, /No ready episodes for this season/);
  assert.doesNotMatch(empty, /S01E|S02E/);
});

test("ready episodes only accompany connected-provider playback", () => {
  const base = { hasPlayerFile: true, launchedEpisodeKey: "1:1", selectedEpisodeKey: "1:1" };
  assert.equal(shouldShowReadyEpisodes({ ...base, session: { backend: "debrid" } }), true);
  assert.equal(shouldShowReadyEpisodes({ ...base, session: { backend: "torrent" } }), false);
  assert.equal(shouldShowReadyEpisodes({ ...base, session: { backend: "usenet" } }), false);
  assert.equal(shouldShowReadyEpisodes({ ...base, session: { backend: "debrid" }, hasPlayerFile: false }), false);
  assert.equal(shouldShowReadyEpisodes({ ...base, session: { backend: "debrid" }, selectedEpisodeKey: "1:2" }), false);
});
