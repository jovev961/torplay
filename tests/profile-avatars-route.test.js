import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/profile-avatars/route.js";

test("profile avatar API discovers images from the public folder", async () => {
  const response = await GET();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.avatars.length > 0);
  assert.equal(data.avatars.every((avatar) => (
    avatar.id && avatar.label && avatar.src === `/profilePictures/${encodeURIComponent(avatar.id)}`
  )), true);
});
