import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const UNPRIVILEGED_PORT_START = 80;

export function enableUnprivilegedPort({
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  procPath = "/proc/sys/net/ipv4/ip_unprivileged_port_start",
  configPath = "/etc/sysctl.d/99-torplay-ports.conf",
} = {}) {
  if (uid !== 0) throw new Error("Administrator authorization is required.");
  const current = Number(readFileSync(procPath, "utf8").trim());
  if (!Number.isInteger(current)) throw new Error("Linux privileged-port configuration is unavailable.");
  if (current > UNPRIVILEGED_PORT_START) {
    writeFileSync(procPath, `${UNPRIVILEGED_PORT_START}\n`, "utf8");
  }
  writeFileSync(
    configPath,
    `# Allow the TorPlay desktop runtime to offer its HTTP service on port 80.\nnet.ipv4.ip_unprivileged_port_start=${UNPRIVILEGED_PORT_START}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
}

function main() {
  if (!process.argv.includes("--enable-port-80")) throw new Error("Unknown privileged helper action.");
  enableUnprivilegedPort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[TorPlay] ${error.message}`);
    process.exitCode = 1;
  }
}
