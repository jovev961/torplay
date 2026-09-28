import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function directoryStats(root) {
  const result = { bytes: 0, files: 0 };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const stats = await lstat(filename);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) await visit(filename);
      else { result.bytes += stats.size; result.files += 1; }
    }
  }
  await visit(root);
  return result;
}

export async function measureRoute(baseUrl, route, runs = 5, fetchImpl = fetch) {
  const samples = [];
  let status = null;
  let bytes = 0;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const response = await fetchImpl(new URL(route, baseUrl), {
      cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    const body = await response.arrayBuffer();
    samples.push(Number((performance.now() - started).toFixed(2)));
    status = response.status;
    bytes = body.byteLength;
  }
  return {
    route, status, bytes, runs, samplesMs: samples,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Math.min(...samples), maxMs: Math.max(...samples),
  };
}

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function main() {
  const baseUrl = argument("base-url", "http://127.0.0.1:3000");
  const runs = Math.max(1, Number(argument("runs", "5")) || 5);
  const runtime = argument("runtime", ".next/standalone");
  const routes = ["/api/health", "/", "/api/settings", "/api/profiles"];
  const measurements = [];
  for (const route of routes) measurements.push(await measureRoute(baseUrl, route, runs));
  const report = {
    recordedAt: new Date().toISOString(), baseUrl, runs,
    runtime: { path: runtime, ...await directoryStats(runtime) },
    routes: measurements,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
