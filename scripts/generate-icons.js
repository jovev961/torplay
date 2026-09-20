import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const BROWSER_ICON_SIZE = 256;
export const APPLE_ICON_SIZE = 180;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const iconPaths = {
  source: path.join(projectRoot, "public", "torplay-logo.png"),
  browserIcon: path.join(projectRoot, "public", "torplay-browser-icon-v1.png"),
  appleIcon: path.join(projectRoot, "public", "torplay-apple-icon-v1.png"),
  windowsIcon: path.join(projectRoot, "installer", "windows", "torplay.ico"),
  legacyBrowserIcons: [
    path.join(projectRoot, "app", "favicon.ico"),
    path.join(projectRoot, "app", "icon.png"),
  ],
};

export function readIcoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("Generated icon is not a valid Windows ICO file.");
  }
  const count = buffer.readUInt16LE(4);
  if (buffer.length < 6 + count * 16) {
    throw new Error("Generated icon directory is incomplete.");
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const width = buffer.readUInt8(offset) || 256;
    const height = buffer.readUInt8(offset + 1) || 256;
    if (width !== height) throw new Error("Generated icon contains a non-square image.");
    return width;
  });
}

export async function generateIcons(paths = iconPaths) {
  const metadata = await sharp(paths.source).metadata();
  if (
    metadata.format !== "png"
    || metadata.width !== metadata.height
    || metadata.width < 256
    || !metadata.hasAlpha
  ) {
    throw new Error("TorPlay source artwork must be a square transparent PNG at least 256 pixels wide.");
  }

  const variants = await Promise.all(WINDOWS_ICON_SIZES.map((size) => (
    sharp(paths.source)
      .resize(size, size, {
        fit: "contain",
        kernel: sharp.kernel.lanczos3,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .sharpen()
      .png()
      .toBuffer()
  )));
  const browserIcon = variants[WINDOWS_ICON_SIZES.indexOf(BROWSER_ICON_SIZE)];
  const ico = await pngToIco(variants);
  const appleIcon = await sharp(paths.source)
    .resize(APPLE_ICON_SIZE, APPLE_ICON_SIZE, {
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .sharpen()
    .png()
    .toBuffer();
  const sizes = readIcoSizes(ico).sort((left, right) => left - right);
  if (sizes.join(",") !== WINDOWS_ICON_SIZES.join(",")) {
    throw new Error(`Generated ICO sizes are invalid: ${sizes.join(", ")}.`);
  }

  await Promise.all([
    mkdir(path.dirname(paths.browserIcon), { recursive: true }),
    mkdir(path.dirname(paths.appleIcon), { recursive: true }),
    mkdir(path.dirname(paths.windowsIcon), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.browserIcon, browserIcon),
    writeFile(paths.appleIcon, appleIcon),
    writeFile(paths.windowsIcon, ico),
    ...(paths.legacyBrowserIcons || []).map((legacyIcon) => rm(legacyIcon, { force: true })),
  ]);
  return { sizes, source: metadata, icoBytes: ico.length };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  generateIcons().then(({ sizes }) => {
    console.log(`Generated TorPlay icons: ${sizes.map((size) => `${size}x${size}`).join(", ")}`);
  }).catch((error) => {
    console.error(`[icons:generate] ${error.message}`);
    process.exitCode = 1;
  });
}
