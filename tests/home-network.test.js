import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { ServiceEvent } from "@homebridge/ciao";
import {
  isPrivateClientAddress,
  startMdnsAdvertisement,
  startReverseProxy,
} from "../scripts/home-network.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("the public frontend accepts only loopback and private LAN addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.1.2",
    "::1",
    "::ffff:192.168.1.20",
    "fe80::1%12",
    "fd00::5",
  ]) {
    assert.equal(isPrivateClientAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "203.0.113.4", "2001:4860:4860::8888", ""]) {
    assert.equal(isPrivateClientAddress(address), false, address);
  }
});

test("the public proxy preserves Range status, headers, and bytes", async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers.range, "bytes=2-5");
    response.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Range": "bytes 2-5/8",
      "Content-Type": "video/mp4",
    });
    response.end(Buffer.from([2, 3, 4, 5]));
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const proxy = await startReverseProxy({
    targetHost: "127.0.0.1",
    targetPort: upstreamPort,
    publicHost: "127.0.0.1",
    publicPort: 0,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/video`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes 2-5/8");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 3, 4, 5]));
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});

test("mDNS waits for advertisement and sends one clean shutdown", async () => {
  const service = new EventEmitter();
  service.advertise = async () => {};
  service.getHostname = () => "torplay.local.";
  let shutdowns = 0;
  let responderOptions;
  let serviceOptions;
  const responderFactory = (options) => {
    responderOptions = options;
    return {
      createService(options) {
        serviceOptions = options;
        return service;
      },
      async shutdown() {
        shutdowns += 1;
      },
    };
  };

  const mdns = await startMdnsAdvertisement({
    hostname: "torplay.local",
    port: 80,
    mdnsInterface: "Wi-Fi",
    responderFactory,
  });
  assert.equal(responderOptions.interface, "Wi-Fi");
  assert.equal(serviceOptions.hostname, "torplay");
  assert.equal(serviceOptions.port, 80);
  await mdns.stop();
  await mdns.stop();
  assert.equal(shutdowns, 1);
});

test("mDNS rejects a hostname collision and shuts the responder down", async () => {
  const service = new EventEmitter();
  service.advertise = async () => {
    service.emit(ServiceEvent.HOSTNAME_CHANGED);
  };
  service.getHostname = () => "torplay-2.local.";
  let shutdowns = 0;
  const responderFactory = () => ({
    createService: () => service,
    async shutdown() {
      shutdowns += 1;
    },
  });

  await assert.rejects(
    () => startMdnsAdvertisement({ hostname: "torplay.local", port: 80, responderFactory }),
    /already in use/,
  );
  assert.equal(shutdowns, 1);
});
