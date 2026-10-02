import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => entry.isDirectory() ? files(path.join(directory, entry.name))
    : entry.name.endsWith(".js") ? [path.join(directory, entry.name)] : []));
  return groups.flat();
}

test("runtime consumers have no obsolete Sources imports and old implementation is absent", async () => {
  const violations = [];
  for (const root of ["app", "components", "lib", "scripts"]) {
    for (const filename of await files(root)) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g)) {
        if (/(?:^|\/)search\/(?:service|provider|contract|processing|result-store|streamable|cardigann|native|torznab|community-directory|jackett-service)/.test(match[1])
          || /settings\/(?:native-sources|torrent-providers)\.js$/.test(match[1])) violations.push(`${filename}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  const old = await stat("lib/search").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (old) assert.deepEqual(await files("lib/search"), []);
});

test("discovery imports generic foundations but does not own acquisition or playback", async () => {
  const sources = await files("lib/sources");
  for (const filename of sources) {
    const text = await readFile(filename, "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*(?:torrent\/manager|debrid\/session|usenet\/jobs|watch-together|subtitles\/service)[^"']*["']/);
  }
  const discovery = await readFile("lib/sources/discovery.js", "utf8");
  assert.ok(discovery.includes("../network/request.js"));
  assert.ok(discovery.includes("../cache/persistent.js"));
  const config = await readFile("lib/sources/configuration.js", "utf8");
  assert.ok(config.includes("../settings/json-file.js"));
  assert.ok(config.includes("../settings/write-queue.js"));
});

test("generic Cardigann runtime contains no native-provider exceptions", async () => {
  for (const filename of await files("lib/sources/cardigann")) {
    assert.doesNotMatch(await readFile(filename, "utf8"), /\b(?:yts|eztv|knaben)\b/i);
  }
});

test("general documentation adds no individual Tested Source names", () => {
  const diff = execFileSync("git", ["diff", "--", "README.md", "docs/development.md", "docs/torrent-providers.md", "docs/installation.md", "docs/releases.md", ".env.example"], { encoding: "utf8" });
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  assert.equal(added.some((line) => /\b(?:YTS|EZTV|Knaben)\b/i.test(line)), false);
});
