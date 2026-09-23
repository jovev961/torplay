import { networkInterfaces as readNetworkInterfaces } from "node:os";

const VIRTUAL_INTERFACE_PATTERNS = [
  /^lo\d*$/i,
  /^awdl\d*$/i,
  /^llw\d*$/i,
  /docker|veth|virbr|vmnet|vbox|wsl|vethernet|hyper-v|default switch/i,
  /podman|kube|tailscale|zerotier|hamachi/i,
  /^br(?:idge)?[-\d]/i,
  /^(?:tun|tap|utun|wg|ppp)\d*/i,
  /vpn/i,
];

function ipv4Octets(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

export function isPrivateLanIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isIpv4(entry) {
  return entry?.family === "IPv4" || entry?.family === 4;
}

function isVirtualInterface(name) {
  return VIRTUAL_INTERFACE_PATTERNS.some((pattern) => pattern.test(name));
}

function interfaceScore(name) {
  if (/ethernet|^eth\d*$|^en(?:o|p|s)\d/i.test(name)) return 400;
  if (/wi-?fi|wireless|wlan|^wl(?:an|p|x)/i.test(name)) return 300;
  if (/^en\d+$/i.test(name)) return 250;
  return 100;
}

function addressNumber(address) {
  return ipv4Octets(address).reduce((number, octet) => number * 256 + octet, 0);
}

function compareCandidates(left, right) {
  return right.score - left.score
    || left.interfaceName.localeCompare(right.interfaceName)
    || addressNumber(left.address) - addressNumber(right.address);
}

export function selectLanAddress(interfaces, { preferredInterface = "" } = {}) {
  const candidates = [];

  for (const [interfaceName, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!isIpv4(entry) || entry.internal || !isPrivateLanIpv4(entry.address)) {
        continue;
      }
      candidates.push({ address: entry.address, interfaceName });
    }
  }

  const preferred = String(preferredInterface || "").trim().toLowerCase();
  if (preferred) {
    const explicit = candidates
      .filter((candidate) => (
        candidate.interfaceName.toLowerCase() === preferred
        || candidate.address === preferred
      ))
      .sort((left, right) => compareCandidates(
        { ...left, score: interfaceScore(left.interfaceName) },
        { ...right, score: interfaceScore(right.interfaceName) },
      ));
    if (explicit[0]) return explicit[0];
  }

  return candidates
    .filter((candidate) => !isVirtualInterface(candidate.interfaceName))
    .map((candidate) => ({ ...candidate, score: interfaceScore(candidate.interfaceName) }))
    .sort(compareCandidates)
    .map(({ address, interfaceName }) => ({ address, interfaceName }))[0] || null;
}

function positivePort(value, fallback) {
  const port = Number(String(value ?? "").trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

function firstHeaderValue(value) {
  return String(value || "").split(",")[0].trim();
}

function requestPort(request, environment) {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const requestHost = firstHeaderValue(request.headers.get("host"));
  const host = forwardedHost || requestHost;
  if (host) {
    try {
      return positivePort(new URL(`http://${host}`).port, 80);
    } catch {
      // Fall through to the validated request URL and configured port.
    }
  }
  return positivePort(
    requestUrl.port,
    positivePort(environment.PORT, positivePort(environment.TORPLAY_PORT, 3000)),
  );
}

function publicHostname(environment) {
  const configured = String(environment.TORPLAY_PUBLIC_HOSTNAME || "").trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(configured)
    ? configured
    : "torplay.local";
}

export function formatLanUrl(hostname, port) {
  return `http://${hostname}${port === 80 ? "" : `:${port}`}`;
}

export function networkAccessDetails(request, {
  environment = process.env,
  interfaces = readNetworkInterfaces(),
} = {}) {
  if (environment.TORPLAY_DISTRIBUTION === "linux-appimage") {
    const port = positivePort(environment.PORT, requestPort(request, environment));
    return {
      scope: "desktop",
      hostnameUrl: formatLanUrl("127.0.0.1", port),
      lanAddress: null,
      lanUrl: null,
    };
  }
  const supervised = positivePort(environment.TORPLAY_SUPERVISOR_PID, 0) > 0;
  const port = supervised
    ? positivePort(environment.TORPLAY_PUBLIC_PORT, 80)
    : requestPort(request, environment);
  const selected = selectLanAddress(interfaces, {
    preferredInterface: environment.TORPLAY_MDNS_INTERFACE,
  });

  return {
    hostnameUrl: formatLanUrl(publicHostname(environment), port),
    lanAddress: selected?.address || null,
    lanUrl: selected ? formatLanUrl(selected.address, port) : null,
  };
}
