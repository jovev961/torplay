import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { createDebridJob, deleteDebridItem, getDebridItem, listDebridLibrary, playDebridItem } from "../lib/debrid/library.js";
import { stopPlayback } from "../lib/debrid/session.js";

const hash = "d".repeat(40);
const context = { type: "show", tmdbId: 55, title: "Example", season: 1, episode: 3 };
const descriptor = { infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`,
  title: "Example season 1", mediaContext: context };
const config = { mode: "prefer-debrid", priority: ["real-debrid", "torbox"],
  localFallback: true, unavailableAction: "ask", credentials: { "real-debrid": { apiKey: "secret" } } };

test("Real-Debrid empty account submits, selects the requested episode, recovers, and retains it after stop", async () => {
  const database = createDatabase(":memory:");
  const calls = { submit: 0, selections: [], deletes: 0 };
  let raw = null;
  const provider = {
    async getAccountInfo() { return { id: 1 }; },
    async listResources() { return raw ? [raw] : []; },
    async submit() {
      calls.submit += 1;
      raw = { id: "rd-1", hash, filename: "Example season 1", status: "waiting_files_selection",
        progress: 0, links: [], files: [1, 2, 3, 4].map((number) => ({
          id: number, path: `/Example/Example.S01E0${number}.mkv`, bytes: 1000, selected: 0,
        })) };
      return raw.id;
    },
    async getResource() { return structuredClone(raw); },
    async selectFiles(_id, files) {
      calls.selections.push(files);
      raw.files.forEach((file) => { file.selected = files.includes(String(file.id)) ? 1 : 0; });
      raw.status = "downloading";
    },
    async resolveStream(_torrent, file) {
      assert.equal(file.providerId, "3");
      return { url: "https://cdn.example/episode-3", resource: { id: "rd-1", owned: true } };
    },
    async deleteResource() { calls.deletes += 1; },
  };
  const dependencies = { database, config, providerFactory: () => provider, probe: async () => {} };
  try {
    const started = await createDebridJob("real-debrid", descriptor, {}, dependencies);
    assert.equal(started.status, "downloading");
    assert.deepEqual(calls.selections, [["3"]]);
    assert.equal(started.selectedFileId, "3");
    const repeated = await createDebridJob("real-debrid", descriptor, {}, dependencies);
    assert.equal(repeated.resourceId, "rd-1");
    assert.equal(calls.submit, 1);
    raw.status = "downloaded";
    raw.progress = 100;
    raw.links = ["https://host.example/episode-3"];
    const ready = await getDebridItem("real-debrid", "rd-1", dependencies);
    assert.equal(ready.status, "ready");
    assert.equal(ready.progress, 1);
    const session = await playDebridItem("real-debrid", "rd-1", "3", dependencies);
    assert.equal(session.backend, "debrid");
    await stopPlayback(session.id);
    assert.equal(calls.deletes, 0);
    assert.equal((await listDebridLibrary({ provider: "real-debrid" }, dependencies)).items[0].ownership, "torplay");
  } finally { database.close(); }
});

test("Real-Debrid full-season choice selects episode videos, excluding samples", async () => {
  const database = createDatabase(":memory:");
  let raw;
  let selected;
  const provider = {
    async getAccountInfo() { return { id: 2 }; },
    async listResources() { return raw ? [raw] : []; },
    async submit() {
      raw = { id: "rd-all", hash, filename: "Example", status: "waiting_files_selection", links: [], files: [
        { id: 1, path: "/Example.S01E02.mkv", bytes: 1000, selected: 0 },
        { id: 2, path: "/Example.S01E03.mkv", bytes: 1000, selected: 0 },
        { id: 3, path: "/sample.mkv", bytes: 100, selected: 0 },
      ] };
      return raw.id;
    },
    async getResource() { return structuredClone(raw); },
    async selectFiles(_id, ids) {
      selected = ids;
      raw.files.forEach((file) => { file.selected = ids.includes(String(file.id)) ? 1 : 0; });
      raw.status = "downloading";
    },
  };
  try {
    const item = await createDebridJob("real-debrid", descriptor, { scope: "all" }, {
      database, config, providerFactory: () => provider,
    });
    assert.deepEqual(selected, ["1", "2"]);
    assert.equal(item.selectedFileId, "2");
    assert.equal(item.progress, null);
  } finally { database.close(); }
});

test("concurrent database connections share one provider submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-debrid-lock-"));
  const filename = path.join(directory, "state.db");
  const firstDb = createDatabase(filename);
  const secondDb = createDatabase(filename);
  let releaseSubmit;
  let signalSubmit;
  const submitting = new Promise((resolve) => { signalSubmit = resolve; });
  const continueSubmit = new Promise((resolve) => { releaseSubmit = resolve; });
  let submitCount = 0;
  let owned = null;
  const provider = {
    async getAccountInfo() { return { id: 99 }; },
    async listResources() { return owned ? [owned] : []; },
    async submit() {
      submitCount += 1;
      signalSubmit();
      await continueSubmit;
      owned = { id: 45, hash, name: "Example", download_state: "downloading", files: [] };
      return 45;
    },
    async getResource() { return structuredClone(owned); },
  };
  const options = { config: { ...config, credentials: { torbox: { apiKey: "secret" } } },
    providerFactory: () => provider };
  try {
    const first = createDebridJob("torbox", descriptor, {}, { ...options, database: firstDb });
    await submitting;
    const second = createDebridJob("torbox", descriptor, {}, { ...options, database: secondDb });
    releaseSubmit();
    const [firstItem, secondItem] = await Promise.all([first, second]);
    assert.equal(firstItem.resourceId, secondItem.resourceId);
    assert.equal(submitCount, 1);
  } finally {
    releaseSubmit();
    firstDb.close();
    secondDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TorBox job reuse and external library deletion are explicit", async () => {
  const database = createDatabase(":memory:");
  let created = 0;
  let deleted = 0;
  const external = { id: 10, hash: "e".repeat(40), name: "External", download_finished: true,
    download_present: true, progress: 1, files: [{ id: 8, name: "External.mp4", size: 1000 }] };
  let owned = null;
  const provider = {
    async getAccountInfo() { return { id: 3 }; },
    async listResources() { return owned ? [external, owned] : [external]; },
    async submit() { created += 1; owned = { id: 11, hash, name: "Example", download_state: "downloading",
      download_finished: false, download_present: false, progress: 0.4, files: [] }; return 11; },
    async getResource(id) { return structuredClone(String(id) === "10" ? external : owned); },
    async deleteResource() { deleted += 1; },
  };
  const dependencies = { database, config: { ...config, credentials: { torbox: { apiKey: "secret" } } },
    providerFactory: () => provider };
  try {
    const before = await listDebridLibrary({ provider: "torbox" }, dependencies);
    assert.equal(before.items[0].ownership, "external");
    const first = await createDebridJob("torbox", descriptor, {}, dependencies);
    assert.equal(first.progress, 0.4);
    const second = await createDebridJob("torbox", descriptor, {}, dependencies);
    assert.equal(second.resourceId, first.resourceId);
    assert.equal(created, 1);
    owned.download_finished = true;
    owned.download_present = true;
    owned.progress = 1;
    owned.files = [3, 4].map((episode) => ({ id: episode,
      name: `Example.S01E0${episode}.mkv`, size: 1000 }));
    const later = await createDebridJob("torbox", {
      ...descriptor, mediaContext: { ...context, episode: 4 },
    }, {}, dependencies);
    assert.equal(later.selectedFileId, "4");
    assert.equal(later.ownership, "torplay");
    assert.equal(created, 1);
    assert.equal((await listDebridLibrary({ provider: "torbox" }, dependencies)).items.find((item) => item.resourceId === "11").ownership, "torplay");
    assert.equal(await deleteDebridItem("torbox", "10", dependencies), true);
    assert.equal(deleted, 1);
  } finally { database.close(); }
});

test("stored provider resource survives a database reopen without another submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-debrid-restart-"));
  const filename = path.join(directory, "state.db");
  let database = createDatabase(filename);
  let count = 0;
  let owned = null;
  const provider = {
    async getAccountInfo() { return { id: 5 }; },
    async listResources() { return owned ? [owned] : []; },
    async submit() { count += 1; owned = { id: 30, hash, name: "Example",
      download_state: "downloading", progress: 0.2, files: [] }; return 30; },
    async getResource() { return structuredClone(owned); },
  };
  const options = { config: { ...config, credentials: { torbox: { apiKey: "secret" } } },
    providerFactory: () => provider };
  try {
    const first = await createDebridJob("torbox", descriptor, {}, { ...options, database });
    database.close();
    database = createDatabase(filename);
    const recovered = await createDebridJob("torbox", descriptor, {}, { ...options, database });
    assert.equal(recovered.resourceId, first.resourceId);
    assert.equal(recovered.ownership, "torplay");
    assert.equal(count, 1);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("library refresh resumes Real-Debrid file selection after restart", async () => {
  const database = createDatabase(":memory:");
  const accountHash = createHash("sha256").update("real-debrid:77").digest("hex");
  database.prepare(`INSERT INTO debrid_resources
    (provider, account_hash, info_hash, resource_id, title, media_context_json,
      selection_scope, ownership, created_at, updated_at)
    VALUES ('real-debrid', ?, ?, 'resume-1', 'Example', ?, 'episode:1:3', 'torplay', 1, 1)`)
    .run(accountHash, hash, JSON.stringify(context));
  let raw = { id: "resume-1", hash, filename: "Example", status: "waiting_files_selection",
    progress: 0, links: [], files: [2, 3].map((episode) => ({ id: episode,
      path: `/Example.S01E0${episode}.mkv`, bytes: 1000, selected: 0 })) };
  let selected = null;
  const provider = {
    async getAccountInfo() { return { id: 77 }; },
    async listResources() { return [raw]; },
    async getResource() { return structuredClone(raw); },
    async selectFiles(_id, ids) {
      selected = ids;
      raw = { ...raw, status: "downloading", files: raw.files.map((file) => ({
        ...file, selected: ids.includes(String(file.id)) ? 1 : 0,
      })) };
    },
  };
  try {
    const result = await listDebridLibrary({ provider: "real-debrid" }, {
      database, config, providerFactory: () => provider,
    });
    assert.deepEqual(selected, ["3"]);
    assert.equal(result.items[0].selectedFileId, "3");
  } finally { database.close(); }
});
