import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrivateLanIpv4,
  networkAccessDetails,
  selectLanAddress,
} from "../lib/network/access.js";
import { copyText } from "../components/copyText.js";

function entry(address, options = {}) {
  return { address, family: "IPv4", internal: false, ...options };
}

test("accepts only RFC1918 private IPv4 addresses", () => {
  for (const address of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.42"]) {
    assert.equal(isPrivateLanIpv4(address), true, address);
  }
  for (const address of ["127.0.0.1", "169.254.2.3", "172.32.0.1", "100.64.0.1", "8.8.8.8", "::1", "invalid"]) {
    assert.equal(isPrivateLanIpv4(address), false, address);
  }
});

test("prefers Ethernet over Wi-Fi and ignores virtual adapters", () => {
  const selected = selectLanAddress({
    "Docker Desktop": [entry("192.168.65.1")],
    "vEthernet (WSL)": [entry("172.21.0.1")],
    utun4: [entry("10.8.0.2")],
    "Wi-Fi": [entry("192.168.1.42")],
    Ethernet: [entry("192.168.1.30")],
    Loopback: [entry("127.0.0.1", { internal: true })],
  });

  assert.deepEqual(selected, { address: "192.168.1.30", interfaceName: "Ethernet" });

  assert.deepEqual(selectLanAddress({
    docker0: [entry("192.168.1.50")],
    Ethernet: [entry("192.168.1.50")],
  }), { address: "192.168.1.50", interfaceName: "Ethernet" });
});

test("supports Linux and macOS physical names and an explicit interface preference", () => {
  const interfaces = {
    en0: [entry("192.168.1.109")],
    enp3s0: [entry("192.168.1.20")],
    wlan0: [entry("192.168.1.21")],
  };

  assert.deepEqual(selectLanAddress(interfaces), {
    address: "192.168.1.20",
    interfaceName: "enp3s0",
  });
  assert.deepEqual(selectLanAddress(interfaces, { preferredInterface: "wlan0" }), {
    address: "192.168.1.21",
    interfaceName: "wlan0",
  });
  assert.deepEqual(selectLanAddress(interfaces, { preferredInterface: "192.168.1.109" }), {
    address: "192.168.1.109",
    interfaceName: "en0",
  });
});

test("keeps unknown localized physical interfaces as a stable fallback", () => {
  const selected = selectLanAddress({
    "Lokales Netzwerk": [entry("192.168.50.9")],
    "Réseau local": [entry("192.168.50.8")],
  });

  assert.deepEqual(selected, { address: "192.168.50.9", interfaceName: "Lokales Netzwerk" });
  assert.equal(selectLanAddress({ lo0: [entry("127.0.0.1", { internal: true })] }), null);
});

test("builds URLs from the active request port for source runtimes", () => {
  const details = networkAccessDetails(
    new Request("http://localhost:3000/api/network-access"),
    {
      environment: { TORPLAY_PUBLIC_HOSTNAME: "living-room.local" },
      interfaces: { "Wi-Fi": [entry("192.168.1.42")] },
    },
  );

  assert.deepEqual(details, {
    hostnameUrl: "http://living-room.local:3000",
    lanAddress: "192.168.1.42",
    lanUrl: "http://192.168.1.42:3000",
  });
});

test("uses the supervised public port and omits the standard HTTP port", () => {
  const request = new Request("http://127.0.0.1:3000/api/network-access");
  const interfaces = { Ethernet: [entry("10.0.0.20")] };

  assert.deepEqual(networkAccessDetails(request, {
    environment: {
      TORPLAY_SUPERVISOR_PID: "42",
      TORPLAY_PUBLIC_HOSTNAME: "torplay.local",
      TORPLAY_PUBLIC_PORT: "80",
    },
    interfaces,
  }), {
    hostnameUrl: "http://torplay.local",
    lanAddress: "10.0.0.20",
    lanUrl: "http://10.0.0.20",
  });

  assert.equal(networkAccessDetails(request, {
    environment: { TORPLAY_SUPERVISOR_PID: "42", TORPLAY_PUBLIC_PORT: "8080" },
    interfaces,
  }).lanUrl, "http://10.0.0.20:8080");
});

test("uses forwarded request ports and returns a safe unavailable state", () => {
  const request = new Request("http://127.0.0.1:3000/api/network-access", {
    headers: { "x-forwarded-host": "torplay.local:4567" },
  });
  const first = networkAccessDetails(request, {
    environment: {},
    interfaces: { "Wi-Fi": [entry("192.168.2.10")] },
  });
  const changed = networkAccessDetails(request, {
    environment: {},
    interfaces: { "Wi-Fi": [entry("192.168.2.11")] },
  });
  const unavailable = networkAccessDetails(request, { environment: {}, interfaces: {} });

  assert.equal(first.lanUrl, "http://192.168.2.10:4567");
  assert.equal(changed.lanUrl, "http://192.168.2.11:4567");
  assert.deepEqual(unavailable, {
    hostnameUrl: "http://torplay.local:4567",
    lanAddress: null,
    lanUrl: null,
  });
});

test("copies with the Clipboard API when available", async () => {
  const values = [];
  const method = await copyText("http://torplay.local", {
    navigatorRef: { clipboard: { writeText: async (value) => values.push(value) } },
    documentRef: null,
  });

  assert.equal(method, "clipboard");
  assert.deepEqual(values, ["http://torplay.local"]);
});

test("falls back to document copy for HTTP LAN pages", async () => {
  const input = {
    style: {},
    setAttribute() {},
    selectCalled: false,
    select() { this.selectCalled = true; },
    removeCalled: false,
    remove() { this.removeCalled = true; },
  };
  const documentRef = {
    body: { appendChild(element) { assert.equal(element, input); } },
    createElement(tag) { assert.equal(tag, "textarea"); return input; },
    execCommand(command) { assert.equal(command, "copy"); return true; },
  };

  const method = await copyText("http://192.168.1.42", {
    navigatorRef: { clipboard: { writeText: async () => { throw new Error("insecure"); } } },
    documentRef,
  });

  assert.equal(method, "fallback");
  assert.equal(input.value, "http://192.168.1.42");
  assert.equal(input.selectCalled, true);
  assert.equal(input.removeCalled, true);
});

test("reports unavailable copy support without leaving an incorrect success state", async () => {
  await assert.rejects(
    copyText("http://torplay.local", { navigatorRef: {}, documentRef: null }),
    /unavailable/,
  );
});
