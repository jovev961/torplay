import assert from "node:assert/strict";
import test from "node:test";
import { closesPlayerMenu, nextMenuIndex } from "../lib/video/menu-navigation.js";

test("subtitle menu arrows move and wrap through every item", () => {
  assert.equal(nextMenuIndex(0, 4, "ArrowDown"), 1);
  assert.equal(nextMenuIndex(3, 4, "ArrowDown"), 0);
  assert.equal(nextMenuIndex(2, 4, "ArrowUp"), 1);
  assert.equal(nextMenuIndex(0, 4, "ArrowUp"), 3);
  assert.equal(nextMenuIndex(-1, 4, "ArrowDown"), 0);
  assert.equal(nextMenuIndex(-1, 4, "ArrowUp"), 3);
});

test("subtitle menu supports boundaries and ignores unrelated keys", () => {
  assert.equal(nextMenuIndex(2, 5, "Home"), 0);
  assert.equal(nextMenuIndex(2, 5, "End"), 4);
  assert.equal(nextMenuIndex(2, 5, "ArrowRight"), -1);
  assert.equal(nextMenuIndex(0, 0, "ArrowDown"), -1);
  assert.equal(nextMenuIndex(0, 1, "ArrowDown"), 0);
  assert.equal(nextMenuIndex(0, 1, "ArrowUp"), 0);
});

test("subtitle menu recognizes keyboard and TV-style close keys", () => {
  for (const key of ["ArrowLeft", "Backspace", "BrowserBack", "Escape", "GoBack"]) {
    assert.equal(closesPlayerMenu(key), true, key);
  }
  assert.equal(closesPlayerMenu("ArrowRight"), false);
  assert.equal(closesPlayerMenu("Enter"), false);
});
