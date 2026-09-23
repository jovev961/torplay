import assert from "node:assert/strict";
import test from "node:test";
import {
  absoluteRemoteMediaUrl,
  remotePlaybackOrigin,
  remotePlaybackSource,
} from "../lib/remote-playback/source.js";
import { castTimeline, createCastLoadRequest } from "../lib/remote-playback/cast.js";
import {
  remoteMediaHeaders,
  remoteMediaOptionsResponse,
  withRemoteMediaCors,
} from "../lib/remote-playback/cors.js";
import {
  isRemotePlaybackSessionActive,
  setRemotePlaybackSessionActive,
} from "../lib/remote-playback/client-state.js";

test("remote playback uses a LAN-visible request origin", () => {
  const request = new Request("http://192.168.1.40/api/playback/remote", {
    headers: { host: "192.168.1.40" },
  });

  assert.equal(remotePlaybackOrigin(request, { NODE_ENV: "production" }), "http://192.168.1.40");
});

test("remote playback replaces a production loopback origin with the home hostname", () => {
  const request = new Request("http://localhost:3000/api/playback/remote");

  assert.equal(remotePlaybackOrigin(request, { NODE_ENV: "production" }), "http://torplay.local");
  assert.equal(remotePlaybackOrigin(request, {
    NODE_ENV: "production",
    TORPLAY_PUBLIC_HOSTNAME: "living-room.local",
    TORPLAY_PUBLIC_PORT: "8080",
  }), "http://living-room.local:8080");
  assert.equal(remotePlaybackOrigin(request, { NODE_ENV: "development" }), "http://localhost:3000");
});

test("remote playback source contains only receiver-safe absolute media URLs", () => {
  const source = remotePlaybackSource({
    origin: "http://torplay.local",
    sessionId: "session-1",
    mediaPath: "/api/torrents/session-1/files/video/stream",
    contentType: "video/mp4",
    title: "Authorized Film",
    duration: 120,
    receiverStartTime: 15,
    subtitles: [{ id: "english", label: "English", language: "en", src: "/captions.vtt" }],
    activeSubtitleId: "english",
  });

  assert.equal(source.url, "http://torplay.local/api/torrents/session-1/files/video/stream");
  assert.equal(source.subtitles[0].url, "http://torplay.local/captions.vtt");
  assert.equal(source.receiverStartTime, 15);
  assert.equal("magnet" in source, false);
  assert.throws(() => absoluteRemoteMediaUrl("file:///tmp/media", "/video.mp4"), /HTTP media origin/);
});

test("Google Cast load requests include metadata, start time, and selected subtitles", () => {
  class MediaInfo {
    constructor(contentId, contentType) {
      this.contentId = contentId;
      this.contentType = contentType;
    }
  }
  class Track {
    constructor(id, type) {
      this.trackId = id;
      this.type = type;
    }
  }
  class LoadRequest {
    constructor(mediaInfo) {
      this.mediaInfo = mediaInfo;
    }
  }
  class Image {
    constructor(url) {
      this.url = url;
    }
  }
  class GenericMediaMetadata {}
  const castApi = {
    Image,
    media: {
      GenericMediaMetadata,
      LoadRequest,
      MediaInfo,
      StreamType: { BUFFERED: "BUFFERED" },
      TextTrackType: { SUBTITLES: "SUBTITLES" },
      Track,
      TrackType: { TEXT: "TEXT" },
    },
  };
  const request = createCastLoadRequest(castApi, {
    url: "http://torplay.local/video.mp4",
    contentType: "video/mp4",
    title: "Authorized Film",
    posterUrl: "https://images.example/poster.jpg",
    receiverStartTime: 42,
    activeSubtitleId: "en",
    subtitles: [{ id: "en", label: "English", language: "en", url: "http://torplay.local/en.vtt" }],
  });

  assert.equal(request.mediaInfo.contentId, "http://torplay.local/video.mp4");
  assert.equal(request.mediaInfo.streamType, "BUFFERED");
  assert.equal(request.mediaInfo.metadata.title, "Authorized Film");
  assert.equal(request.mediaInfo.metadata.images[0].url, "https://images.example/poster.jpg");
  assert.equal(request.mediaInfo.tracks[0].trackContentId, "http://torplay.local/en.vtt");
  assert.deepEqual(request.activeTrackIds, [1]);
  assert.equal(request.currentTime, 42);
});

test("Cast HLS timelines preserve the source media position", () => {
  assert.deepEqual(
    castTimeline({ originSeconds: 600, duration: 3_600 }, { currentTime: 12, duration: 60 }),
    { position: 612, duration: 3_600 },
  );
  assert.deepEqual(
    castTimeline({ originSeconds: 600, duration: 0 }, { currentTime: 12, duration: 60 }),
    { position: 612, duration: 660 },
  );
});

test("receiver-facing responses expose Range and CORS headers", async () => {
  const headers = remoteMediaHeaders({ "Content-Range": "bytes 0-9/100" });
  assert.equal(headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(headers.get("Access-Control-Allow-Private-Network"), "true");
  assert.match(headers.get("Access-Control-Allow-Headers"), /Range/);
  assert.match(headers.get("Access-Control-Expose-Headers"), /Content-Range/);

  const response = withRemoteMediaCors(new Response("video", { status: 206 }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await response.text(), "video");

  const options = remoteMediaOptionsResponse();
  assert.equal(options.status, 204);
  assert.match(options.headers.get("Access-Control-Allow-Methods"), /HEAD/);
});

test("remote torrent sessions remain marked only while a receiver owns them", () => {
  setRemotePlaybackSessionActive("session-remote", true);
  assert.equal(isRemotePlaybackSessionActive("session-remote"), true);
  setRemotePlaybackSessionActive("session-remote", false);
  assert.equal(isRemotePlaybackSessionActive("session-remote"), false);
});
