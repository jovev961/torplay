import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  directionalCandidate,
  isEditableArrowTarget,
  normalizeRemoteKey,
} from "../lib/ui/spatial-navigation.js";

function candidate(element, x, y) {
  return { element, x, y };
}

test("normalizes browser and vendor TV back keys without changing keyboard arrows", () => {
  assert.equal(normalizeRemoteKey("BrowserBack"), "Back");
  assert.equal(normalizeRemoteKey("Unidentified", 10009), "Back");
  assert.equal(normalizeRemoteKey("Unidentified", 461), "Back");
  assert.equal(normalizeRemoteKey("ArrowRight"), "ArrowRight");
});

test("directional navigation prefers the nearest item on the requested axis", () => {
  const origin = candidate("origin", 100, 100);
  const items = [origin, candidate("right", 180, 105), candidate("far-right", 300, 100),
    candidate("down", 105, 180), candidate("diagonal", 160, 170)];
  assert.equal(directionalCandidate(origin, items, "ArrowRight"), "right");
  assert.equal(directionalCandidate(origin, items, "ArrowDown"), "down");
  assert.equal(directionalCandidate(origin, items, "ArrowLeft"), null);
});

test("text and range controls retain horizontal editing keys", () => {
  assert.equal(isEditableArrowTarget({ tagName: "INPUT", type: "text" }, "ArrowLeft"), true);
  assert.equal(isEditableArrowTarget({ tagName: "INPUT", type: "text" }, "ArrowDown"), false);
  assert.equal(isEditableArrowTarget({ tagName: "INPUT", type: "range" }, "ArrowRight"), true);
  assert.equal(isEditableArrowTarget({ tagName: "TEXTAREA" }, "ArrowDown"), true);
});

test("important TV dropdowns use the remote-safe listbox", async () => {
  for (const file of ["CatalogFilters.js", "ShowDetails.js", "ProfileManager.js",
    "DebridSettings.js", "AddSourceDialog.js", "VideoPlayer.js"]) {
    const source = await readFile(new URL(`../components/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /<select\b/, file);
    assert.match(source, /RemoteSelect/, file);
  }
});
