import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function document(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("README presents the standalone Windows installer as the normal path", async () => {
  const readme = await document("README.md");

  assert.match(readme, /## Install on Windows/);
  assert.match(readme, /github\.com\/jovev961\/torplay\/releases/);
  assert.match(readme, /does not require Node\.js, npm, Docker, Jackett, FlareSolverr, or a source checkout/);
  assert.match(readme, /themoviedb\.org\/settings\/api/);
  assert.ok(readme.indexOf("## Developer/source setup") > readme.indexOf("## Install on Windows"));
});

test("Windows guide covers installation, first run, operation, and maintenance", async () => {
  const guide = await document("docs/windows-deployment.md");

  for (const heading of [
    "## Download TorPlay",
    "## Install",
    "## First-time setup",
    "## System-tray controls",
    "## Logs and basic troubleshooting",
    "## Update or reinstall",
    "## Uninstall",
  ]) {
    assert.match(guide, new RegExp(heading));
  }

  for (const officialUrl of [
    "https://developer.themoviedb.org/docs/getting-started",
    "https://www.themoviedb.org/settings/api",
    "https://www.omdbapi.com/apikey.aspx",
    "https://www.opensubtitles.com/en/consumers",
    "https://subdl.com/panel/api",
    "https://github.com/Jackett/Jackett",
  ]) {
    assert.match(guide, new RegExp(officialUrl.replaceAll(".", "\\.")));
  }

  assert.match(guide, /%LOCALAPPDATA%\\TorPlay\\logs\\torplay\.log/);
  assert.match(guide, /does not require developer tools, a source checkout, Docker Desktop, Jackett, or FlareSolverr/);
  assert.doesNotMatch(guide, /npm run release:windows/);
});

test("source and installer build instructions remain in the development guide", async () => {
  const guide = await document("docs/development.md");

  assert.match(guide, /## Build the Windows installer/);
  assert.match(guide, /npm run release:windows/);
  assert.match(guide, /Pull requests and pushes do not trigger it/);
});

test("installed readme points first-time users to browser setup", async () => {
  const readme = await document("installer/windows/INSTALLED-README.txt");

  assert.match(readme, /^TorPlay for Windows/);
  assert.match(readme, /http:\/\/localhost\/setup/);
  assert.match(readme, /themoviedb\.org\/settings\/api/);
  assert.match(readme, /without requiring an environment file/);
});

test("local links in the standalone setup documents resolve", async () => {
  for (const relativePath of ["README.md", "docs/README.md", "docs/windows-deployment.md"]) {
    const contents = await document(relativePath);
    const links = [...contents.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

    for (const link of links) {
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = link.split("#", 1)[0];
      await assert.doesNotReject(
        () => access(path.resolve(root, path.dirname(relativePath), target)),
        `${relativePath} links to missing file ${target}`,
      );
    }
  }
});
