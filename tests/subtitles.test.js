import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySubtitleFile,
  MAX_SUBTITLE_BYTES,
  SubtitleError,
  subtitleMatchesVideo,
  subtitleMetadata,
  subtitleToWebVtt,
} from "../lib/video/subtitles.js";

test("classifies browser-ready subtitle sidecars", () => {
  assert.deepEqual(classifySubtitleFile("Movie.EN.SRT"), {
    format: "srt",
    mimeType: "text/vtt; charset=utf-8",
  });
  assert.deepEqual(classifySubtitleFile("Movie.vtt"), {
    format: "vtt",
    mimeType: "text/vtt; charset=utf-8",
  });
  assert.equal(classifySubtitleFile("Movie.ass"), null);
  assert.equal(classifySubtitleFile("Movie.mp4"), null);
});

test("infers subtitle language labels and accessibility qualifiers", () => {
  assert.deepEqual(subtitleMetadata("Movie.English.SDH.srt"), {
    language: "en",
    label: "English (SDH)",
  });
  assert.deepEqual(subtitleMetadata("Subs/Commentary.vtt"), {
    language: "und",
    label: "Commentary",
  });
});

test("matches subtitles without crossing episodes in a pack", () => {
  const first = { path: "Show/Show.S01E01.mkv" };
  const second = { path: "Show/Show.S01E02.mkv" };
  assert.equal(subtitleMatchesVideo(first, { path: "Show/Show.S01E01.en.srt" }, 2), true);
  assert.equal(subtitleMatchesVideo(first, { path: "Show/Show.S01E02.en.srt" }, 2), false);
  assert.equal(subtitleMatchesVideo(second, { path: "Show/Show.S01E02.en.srt" }, 2), true);
  assert.equal(subtitleMatchesVideo(first, { path: "Subs/English.srt" }, 2), false);
  assert.equal(subtitleMatchesVideo(first, { path: "Subs/English.srt" }, 1), true);
  assert.equal(subtitleMatchesVideo(
    { path: "Show/Season 01/Episode 01/video.mkv" },
    { path: "Show/Season 01/Episode 01/English.srt" },
    2,
  ), true);
  assert.equal(subtitleMatchesVideo(
    { path: "Show/Season 01/Episode 01/video.mkv" },
    { path: "Show/Season 01/Episode 02/English.srt" },
    2,
  ), false);
});

test("converts SubRip cues into valid WebVTT", () => {
  const input = new TextEncoder().encode(
    "1\r\n00:00:01,250 --> 00:00:03,500\r\nHello world\r\n",
  );
  assert.equal(
    subtitleToWebVtt(input, "srt"),
    "WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\nHello world\n",
  );
});

test("passes valid WebVTT and rejects malformed or oversized subtitles", () => {
  const valid = new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:01.000\nHi");
  assert.equal(
    subtitleToWebVtt(valid, "vtt"),
    "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n",
  );
  assert.throws(
    () => subtitleToWebVtt(new TextEncoder().encode("not vtt"), "vtt"),
    SubtitleError,
  );
  assert.throws(
    () => subtitleToWebVtt(new Uint8Array(MAX_SUBTITLE_BYTES + 1), "srt"),
    (error) => error instanceof SubtitleError && error.status === 413,
  );
});

function encodeLegacy(encoding, text) {
  const decoder = new TextDecoder(encoding);
  const bytesByCharacter = new Map();
  for (let byte = 0; byte <= 255; byte += 1) {
    const character = decoder.decode(Uint8Array.of(byte));
    if (character !== "\uFFFD") bytesByCharacter.set(character, byte);
  }
  return Uint8Array.from([...text].map((character) => {
    const byte = bytesByCharacter.get(character);
    if (byte === undefined) throw new Error(`Cannot encode ${character} as ${encoding}.`);
    return byte;
  }));
}

test("normalizes Windows-1251 and Windows-1250 Balkan subtitles to UTF-8 WebVTT", () => {
  const cyrillic = "Ѓ Ќ Љ Њ Ѕ Џ Ђ Ј Ћ Ова е македонски и српски текст со кирилични букви.";
  const latin = "Č Ć Ž Š Đ Ovo je hrvatski, bosanski i srpski tekst.";
  for (const [encoding, body] of [["windows-1251", cyrillic], ["windows-1250", latin]]) {
    const input = `1\n00:00:01,000 --> 00:00:03,000\n${body}\n`.repeat(10);
    assert.match(subtitleToWebVtt(encodeLegacy(encoding, input), "srt"), new RegExp(body));
  }
});

test("keeps subtitle cues on their original media timeline", () => {
  const input = new TextEncoder().encode(
    "1\n00:00:05,000 --> 00:00:07,000\nDelayed line\n",
  );
  assert.match(subtitleToWebVtt(input, "srt"), /00:00:05\.000 --> 00:00:07\.000/);
});
