import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const suite = process.argv[2];
if (!new Set(["unit", "integration"]).has(suite)) {
  console.error("Usage: node scripts/run-test-suite.js <unit|integration>");
  process.exit(2);
}

const integrationFiles = new Set([
  "home-network.test.js",
  "linux-packaging.test.js",
  "season-pack.integration.test.js",
  "transcode.test.js",
  "watch-together-reconnect.integration.test.js",
  "watch-together-redis.integration.test.js",
  "watch-together-signaling.test.js",
  "watch-together.test.js",
  "windows-packaging.test.js",
]);
const directory = path.resolve("tests");
const allTests = (await readdir(directory)).filter((file) => file.endsWith(".test.js")).sort();
const files = allTests.filter((file) => integrationFiles.has(file) === (suite === "integration"));
const child = spawn(process.execPath, ["--test", ...files.map((file) => path.join(directory, file))], {
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
