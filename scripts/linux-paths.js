import os from "node:os";
import path from "node:path";

function xdgPath(environment, key, fallback) {
  const value = environment[key]?.trim();
  return value && path.isAbsolute(value) ? value : path.join(os.homedir(), fallback);
}

export function linuxPaths(environment = process.env) {
  const config = path.join(xdgPath(environment, "XDG_CONFIG_HOME", ".config"), "torplay");
  const data = path.join(xdgPath(environment, "XDG_DATA_HOME", ".local/share"), "torplay");
  const cache = path.join(xdgPath(environment, "XDG_CACHE_HOME", ".cache"), "torplay");
  const state = path.join(xdgPath(environment, "XDG_STATE_HOME", ".local/state"), "torplay");
  const runtime = path.join(
    environment.XDG_RUNTIME_DIR && path.isAbsolute(environment.XDG_RUNTIME_DIR)
      ? environment.XDG_RUNTIME_DIR
      : state,
    "torplay",
  );
  return {
    config, data, cache, state, runtime,
    configPath: path.join(config, "torplay.env"),
    databasePath: path.join(data, "torplay.db"),
    torrentPath: path.join(data, "torrents"),
    subtitlePath: path.join(cache, "subtitles"),
    nextRuntimePath: path.join(cache, "next-runtime"),
    logPath: path.join(state, "torplay.log"),
    statusPath: path.join(state, "status.json"),
    lockPath: path.join(runtime, "runtime.lock"),
    controlPath: path.join(runtime, "control.sock"),
  };
}

export function linuxRuntimeEnvironment(paths, environment = process.env) {
  const storagePath = (value, fallback) => value && path.isAbsolute(value) ? value : fallback;
  return {
    ...environment,
    NODE_ENV: "production",
    TORPLAY_DISTRIBUTION: "linux-appimage",
    TORPLAY_CONFIG_PATH: paths.configPath,
    TORPLAY_DATABASE_PATH: storagePath(environment.TORPLAY_DATABASE_PATH, paths.databasePath),
    TORRENT_DOWNLOAD_PATH: storagePath(environment.TORRENT_DOWNLOAD_PATH, paths.torrentPath),
    SUBTITLE_CACHE_PATH: storagePath(environment.SUBTITLE_CACHE_PATH, paths.subtitlePath),
    TORPLAY_STATUS_PATH: paths.statusPath,
    TORPLAY_LOG_PATH: paths.logPath,
    TORPLAY_RUNTIME_DIR: paths.runtime,
    TORPLAY_CONTROL_ENDPOINT: paths.controlPath,
    TORPLAY_HOST: "127.0.0.1",
  };
}
