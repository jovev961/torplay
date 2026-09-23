import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.join(projectRoot, "lib");
const platformRoots = ["app", "components", "platform", "scripts"]
  .map((directory) => path.join(projectRoot, directory));

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  }));
  return nested.flat();
}

function moduleSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

test("core modules do not depend on Next.js or platform adapters", async () => {
  const violations = [];
  for (const filename of await javascriptFiles(coreRoot)) {
    const source = await readFile(filename, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier === "next" || specifier.startsWith("next/")) {
        violations.push(`${path.relative(projectRoot, filename)} imports ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(filename), specifier);
      if (platformRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
        violations.push(`${path.relative(projectRoot, filename)} imports ${path.relative(projectRoot, resolved)}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
