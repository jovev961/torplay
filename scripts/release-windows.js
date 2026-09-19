import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

export const NODE_VERSION = "24.21.0";
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
export const NODE_ARCHIVE_SHA256 =
  "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541";
export const INNO_VERSION = "7.1.0";

export function windowsFileVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported Windows release version: ${version}`);
  }

  const parts = [match[1], match[2], match[3], match[4] || "0"].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65_535)) {
    throw new Error(`Windows release version is out of range: ${version}`);
  }

  return parts.join(".");
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const releaseRoot = path.join(projectRoot, ".release", "windows");
const stageDir = path.join(releaseRoot, "stage");
const cacheDir = path.join(projectRoot, ".release", "cache");
const outputDir = path.join(projectRoot, "dist", "windows");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with exit code ${result.status}.`,
    );
  }
}

/*
 * npm on Windows is exposed through npm.cmd.
 *
 * Spawning npm.cmd directly with spawnSync can fail with EINVAL.
 * Run npm through cmd.exe instead.
 */
function runNpm(args, options = {}) {
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec || "cmd.exe";

    run(
      cmd,
      ["/d", "/s", "/c", "npm", ...args],
      options,
    );

    return;
  }

  run("npm", args, options);
}

export function sha256(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status}: ${url}`,
    );
  }

  writeFileSync(
    destination,
    Buffer.from(await response.arrayBuffer()),
  );
}

function findFiles(root, basename, found = []) {
  if (!existsSync(root)) {
    return found;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      findFiles(entryPath, basename, found);
    } else if (
      entry.name.toLowerCase() === basename.toLowerCase()
    ) {
      found.push(entryPath);
    }
  }

  return found;
}

export function validateStage(root = stageDir) {
  const required = [
    path.join(root, "runtime", "node.exe"),
    path.join(root, "runtime", "home.mjs"),
    path.join(root, "runtime", "windows-runner.mjs"),
    path.join(root, "runtime", "windows-control.mjs"),
    path.join(root, "app", "server.js"),
    path.join(root, "docker-compose.yml"),
  ];

  for (const requiredPath of required) {
    if (!existsSync(requiredPath)) {
      throw new Error(
        `Release staging is missing ${requiredPath}.`,
      );
    }
  }

  for (const nativeFile of [
    "better_sqlite3.node",
    "ffmpeg.exe",
    "ffprobe.exe",
  ]) {
    if (
      findFiles(
        path.join(root, "app"),
        nativeFile,
      ).length === 0
    ) {
      throw new Error(
        `The standalone Windows build is missing ${nativeFile}.`,
      );
    }
  }

  if (findFiles(root, ".env.local").length > 0) {
    throw new Error(
      "Release staging must not contain .env.local.",
    );
  }
}

function resolveIscc(environment = process.env) {
  const candidates = [
    environment.INNO_SETUP_COMPILER,

    environment["ProgramFiles(x86)"]
      ? path.join(
          environment["ProgramFiles(x86)"],
          "Inno Setup 7",
          "ISCC.exe",
        )
      : null,

    environment.LOCALAPPDATA
      ? path.join(
          environment.LOCALAPPDATA,
          "Programs",
          "Inno Setup 7",
          "ISCC.exe",
        )
      : null,
  ].filter(Boolean);

  const compiler = candidates.find((candidate) =>
    existsSync(candidate),
  );

  if (!compiler) {
    throw new Error(
      `Inno Setup ${INNO_VERSION} is required. ` +
        "Install it or set INNO_SETUP_COMPILER to ISCC.exe.",
    );
  }

  const version = spawnSync(
    compiler,
    ["--version"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  const output =
    `${version.stdout || ""}\n${version.stderr || ""}`;

  if (
    version.status !== 0 ||
    !output.includes(INNO_VERSION)
  ) {
    throw new Error(
      `Expected Inno Setup ${INNO_VERSION}; ` +
        `ISCC reported ${output.trim() || "an error"}.`,
    );
  }

  return compiler;
}

function bundle(entry, outfile) {
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",

    banner: {
      js: `
import { createRequire as __torplayCreateRequire } from "node:module";
const require = __torplayCreateRequire(import.meta.url);
`,
    },
  });
}

async function prepareNodeRuntime() {
  mkdirSync(cacheDir, { recursive: true });

  const archivePath = path.join(
    cacheDir,
    NODE_ARCHIVE,
  );

  if (
    !existsSync(archivePath) ||
    sha256(archivePath) !== NODE_ARCHIVE_SHA256
  ) {
    rmSync(archivePath, { force: true });

    console.log(
      `Downloading Node.js ${NODE_VERSION}...`,
    );

    await download(
      `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`,
      archivePath,
    );
  }

  const actual = sha256(archivePath);

  if (actual !== NODE_ARCHIVE_SHA256) {
    throw new Error(
      `Node.js checksum mismatch: expected ` +
        `${NODE_ARCHIVE_SHA256}, received ${actual}.`,
    );
  }

  const extractDir = path.join(
    releaseRoot,
    "node",
  );

  rmSync(extractDir, {
    recursive: true,
    force: true,
  });

  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Expand-Archive",
    "-LiteralPath",
    archivePath,
    "-DestinationPath",
    extractDir,
    "-Force",
  ]);

  const nodeRoot = path.join(
    extractDir,
    `node-v${NODE_VERSION}-win-x64`,
  );

  cpSync(
    path.join(nodeRoot, "node.exe"),
    path.join(stageDir, "runtime", "node.exe"),
  );

  cpSync(
    path.join(nodeRoot, "LICENSE"),
    path.join(
      stageDir,
      "runtime",
      "NODE-LICENSE.txt",
    ),
  );
}

async function stageRuntime() {
  rmSync(releaseRoot, {
    recursive: true,
    force: true,
  });

  mkdirSync(
    path.join(stageDir, "runtime"),
    { recursive: true },
  );

  mkdirSync(
    path.join(stageDir, "config"),
    { recursive: true },
  );

  const standalone = path.join(
    projectRoot,
    ".next",
    "standalone",
  );

  if (
    !existsSync(
      path.join(standalone, "server.js"),
    )
  ) {
    throw new Error(
      "Next.js standalone output is missing after the production build.",
    );
  }

  cpSync(
    standalone,
    path.join(stageDir, "app"),
    { recursive: true },
  );

  cpSync(
    path.join(projectRoot, ".next", "static"),
    path.join(
      stageDir,
      "app",
      ".next",
      "static",
    ),
    { recursive: true },
  );

  const publicDir = path.join(
    projectRoot,
    "public",
  );

  if (existsSync(publicDir)) {
    cpSync(
      publicDir,
      path.join(stageDir, "app", "public"),
      { recursive: true },
    );
  }

  bundle(
    path.join(
      projectRoot,
      "scripts",
      "home.js",
    ),
    path.join(
      stageDir,
      "runtime",
      "home.mjs",
    ),
  );

  bundle(
    path.join(
      projectRoot,
      "scripts",
      "windows-runner.js",
    ),
    path.join(
      stageDir,
      "runtime",
      "windows-runner.mjs",
    ),
  );

  bundle(
    path.join(
      projectRoot,
      "scripts",
      "windows-control.js",
    ),
    path.join(
      stageDir,
      "runtime",
      "windows-control.mjs",
    ),
  );

  for (const [source, destination] of [
    [
      "docker-compose.yml",
      "docker-compose.yml",
    ],
    [
      "installer/windows/torplay-launcher.vbs",
      "runtime/torplay-launcher.vbs",
    ],
    [
      "installer/windows/torplay-status.cmd",
      "runtime/torplay-status.cmd",
    ],
    [
      "scripts/windows-firewall.ps1",
      "runtime/windows-firewall.ps1",
    ],
    [
      "installer/windows/torplay.env",
      "config/torplay.env",
    ],
    [
      "installer/windows/INSTALLED-README.txt",
      "README.txt",
    ],
  ]) {
    cpSync(
      path.join(projectRoot, source),
      path.join(stageDir, destination),
    );
  }

  await prepareNodeRuntime();

  const packageJson = JSON.parse(
    readFileSync(
      path.join(projectRoot, "package.json"),
      "utf8",
    ),
  );

  writeFileSync(
    path.join(stageDir, "release.json"),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        node: NODE_VERSION,
        architecture: "win32-x64",
      },
      null,
      2,
    )}\n`,
  );

  validateStage();
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64"
  ) {
    throw new Error(
      "npm run release:windows must run on Windows x64 " +
        "so native runtime files are correct.",
    );
  }

  /*
   * Do not spawn npm.cmd directly.
   * runNpm() goes through cmd.exe on Windows.
   */
  runNpm(["test"]);

  runNpm(["run", "lint"]);

  runNpm(
    ["run", "build"],
    {
      env: {
        ...process.env,
        TORPLAY_STANDALONE_BUILD: "1",
      },
    },
  );

  await stageRuntime();

  mkdirSync(outputDir, {
    recursive: true,
  });

  const packageJson = JSON.parse(
    readFileSync(
      path.join(projectRoot, "package.json"),
      "utf8",
    ),
  );

  const compiler = resolveIscc();

  run(
    compiler,
    [
      `/DStageDir=${stageDir}`,
      `/DOutputDir=${outputDir}`,
      `/DAppVersion=${packageJson.version}`,
      `/DVersionInfoVersion=${windowsFileVersion(packageJson.version)}`,
      path.join(
        projectRoot,
        "installer",
        "windows",
        "torplay.iss",
      ),
    ],
  );

  const installer = path.join(
    outputDir,
    `TorPlay-Setup-${packageJson.version}.exe`,
  );

  if (
    !existsSync(installer) ||
    statSync(installer).size === 0
  ) {
    throw new Error(
      "Inno Setup did not create the expected installer.",
    );
  }

  const digest = sha256(installer);

  writeFileSync(
    `${installer}.sha256`,
    `${digest}  ${path.basename(installer)}\n`,
  );

  console.log(
    `Windows installer: ${installer}`,
  );

  console.log(
    `SHA-256: ${digest}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(
      `[release:windows] ${error.message}`,
    );

    process.exitCode = 1;
  });
}
