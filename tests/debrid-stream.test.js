import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { openRemoteUrl, proxyRemoteFile, probeRemoteUrl } from "../lib/debrid/stream.js";

function mockRequest(statusCode, headers, bytes, onRequest = () => {}) {
  return (url, options, callback) => {
    onRequest(url, options);
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = statusCode;
      response.headers = headers;
      queueMicrotask(() => {
        callback(response);
        response.end(bytes);
      });
    };
    request.destroy = () => request.emit("error", new Error("closed"));
    return request;
  };
}

const resolveImpl = async () => [{ address: "93.184.215.14", family: 4 }];
const file = { length: 10, mimeType: "video/mp4" };

test("debrid proxy forwards exact ranges and uses validated public DNS", async () => {
  let upstreamRange = null;
  const requestImpl = mockRequest(206, { "content-range": "bytes 2-4/10" }, "cde",
    (_url, options) => {
      upstreamRange = options.headers.Range;
      options.lookup("cdn.example", {}, (_error, address) => {
        assert.equal(address, "93.184.215.14");
      });
      options.lookup("cdn.example", { all: true }, (_error, addresses) => {
        assert.deepEqual(addresses, [{ address: "93.184.215.14", family: 4 }]);
      });
    });
  const response = await proxyRemoteFile(
    new Request("https://torplay.local/media", { headers: { Range: "bytes=2-4" } }),
    file, async () => "https://cdn.example/file", { requestImpl, resolveImpl },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(response.headers.get("content-length"), "3");
  assert.equal(upstreamRange, "bytes=2-4");
  assert.equal(await response.text(), "cde");
});

test("HEAD and invalid ranges never open an upstream connection", async () => {
  const rejectRequest = () => { throw new Error("No upstream request expected"); };
  const head = await proxyRemoteFile(new Request("https://torplay.local/media", {
    method: "HEAD", headers: { Range: "bytes=2-4" },
  }), file, rejectRequest);
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-range"), "bytes 2-4/10");
  const invalid = await proxyRemoteFile(new Request("https://torplay.local/media", {
    headers: { Range: "bytes=20-30" },
  }), file, rejectRequest);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
});

test("remote probe checks byte-range support", async () => {
  await probeRemoteUrl("https://cdn.example/file", {
    resolveImpl,
    requestImpl: mockRequest(206, { "content-range": "bytes 0-0/10" }, "a"),
  });
  await assert.rejects(probeRemoteUrl("https://cdn.example/file", {
    resolveImpl,
    requestImpl: mockRequest(200, {}, "all"),
  }), /byte ranges/);
});

test("remote proxy rejects private redirect targets and excessive redirects", async () => {
  await assert.rejects(openRemoteUrl("https://cdn.example/file", {
    resolveImpl,
    requestImpl: mockRequest(302, { location: "https://127.0.0.1/private" }, ""),
  }), /unsafe/);
  await assert.rejects(openRemoteUrl("https://cdn.example/file", {
    resolveImpl,
    requestImpl: mockRequest(302, { location: "/loop" }, ""),
  }), /too many times/);
  await assert.rejects(openRemoteUrl("https://192.168.1.1/private", {
    requestImpl: () => { throw new Error("No request expected"); },
  }), /unsafe/);
  await assert.rejects(openRemoteUrl("https://cdn.example/file", {
    resolveImpl: async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ],
    requestImpl: () => { throw new Error("No request expected"); },
  }), /unsafe/);
});

test("invalid upstream range fails before returning media bytes", async () => {
  await assert.rejects(proxyRemoteFile(
    new Request("https://torplay.local/media", { headers: { Range: "bytes=2-4" } }),
    file, async () => "https://cdn.example/file", {
      resolveImpl,
      requestImpl: mockRequest(200, {}, "full media"),
    },
  ), /byte ranges/);
});

test("HTTP 451 media URL is resolved once more before returning the requested range", async () => {
  let attempts = 0;
  const resolved = [];
  const requestImpl = (url, options, callback) => {
    attempts += 1;
    return mockRequest(
      attempts === 1 ? 451 : 206,
      attempts === 1 ? {} : { "content-range": "bytes 2-4/10" },
      attempts === 1 ? "" : "cde",
    )(url, options, callback);
  };
  const response = await proxyRemoteFile(
    new Request("https://torplay.local/media", { headers: { Range: "bytes=2-4" } }),
    file,
    async (force) => {
      resolved.push(force);
      return "https://cdn.example/file";
    },
    { resolveImpl, requestImpl },
  );
  assert.equal(await response.text(), "cde");
  assert.deepEqual(resolved, [false, true]);
});

test("remote transport failure refreshes the URL once", async () => {
  let attempts = 0;
  const resolved = [];
  const requestImpl = (url, options, callback) => {
    attempts += 1;
    if (attempts > 1) {
      return mockRequest(206, { "content-range": "bytes 2-4/10" }, "cde")(
        url, options, callback);
    }
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit("error", new Error("connection closed")));
    request.destroy = () => {};
    return request;
  };
  const response = await proxyRemoteFile(
    new Request("https://torplay.local/media", { headers: { Range: "bytes=2-4" } }),
    file,
    async (force) => {
      resolved.push(force);
      return "https://cdn.example/file";
    },
    { resolveImpl, requestImpl },
  );
  assert.equal(await response.text(), "cde");
  assert.deepEqual(resolved, [false, true]);
});

test("a repeated HTTP 451 returns an actionable provider error after one refresh", async () => {
  const resolved = [];
  await assert.rejects(proxyRemoteFile(
    new Request("https://torplay.local/media", { headers: { Range: "bytes=2-4" } }),
    file,
    async (force) => {
      resolved.push(force);
      return "https://cdn.example/file";
    },
    { resolveImpl, requestImpl: mockRequest(451, {}, "") },
  ), (error) => error.code === "remote-stream-unavailable"
    && error.upstreamStatus === 451 && /HTTP 451/.test(error.message));
  assert.deepEqual(resolved, [false, true]);
});

test("canceling a media response closes the upstream stream", async () => {
  let upstream = null;
  const requestImpl = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      upstream = new PassThrough();
      upstream.statusCode = 206;
      upstream.headers = { "content-range": "bytes 0-9/10" };
      queueMicrotask(() => callback(upstream));
    };
    return request;
  };
  const response = await proxyRemoteFile(
    new Request("https://torplay.local/media"), file,
    async () => "https://cdn.example/file", { resolveImpl, requestImpl },
  );
  await response.body.cancel();
  assert.equal(upstream.destroyed, true);
});
