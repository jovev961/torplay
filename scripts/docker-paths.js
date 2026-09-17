import { existsSync } from "node:fs";
import path from "node:path";

const MAC_DOCKER_PATH = "/Applications/Docker.app/Contents/Resources/bin/docker";

export function windowsDockerPaths(environment = process.env) {
  return [
    environment.DOCKER_CLI_PATH,
    environment.LOCALAPPDATA
      ? path.join(environment.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe")
      : null,
    environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe")
      : null,
  ].filter(Boolean);
}

export function windowsDockerDesktopPaths(environment = process.env) {
  return [
    environment.DOCKER_DESKTOP_PATH,
    environment.LOCALAPPDATA
      ? path.join(environment.LOCALAPPDATA, "Programs", "DockerDesktop", "Docker Desktop.exe")
      : null,
    environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe")
      : null,
  ].filter(Boolean);
}

export function resolveDockerCommand({
  platform = process.platform,
  environment = process.env,
  fileExists = existsSync,
} = {}) {
  if (platform === "darwin" && fileExists(MAC_DOCKER_PATH)) return MAC_DOCKER_PATH;
  if (platform === "win32") {
    return windowsDockerPaths(environment).find((candidate) => fileExists(candidate)) || "docker";
  }
  return "docker";
}

export function resolveDockerDesktopCommand({
  platform = process.platform,
  environment = process.env,
  fileExists = existsSync,
} = {}) {
  if (platform !== "win32") return null;
  return windowsDockerDesktopPaths(environment).find((candidate) => fileExists(candidate)) || null;
}

export { MAC_DOCKER_PATH };
