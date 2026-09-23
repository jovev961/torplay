import path from "node:path";

export function installedPaths({
  installDir = process.env.TORPLAY_INSTALL_DIR,
  dataDir = process.env.TORPLAY_DATA_DIR,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const resolvedInstall = installDir || path.join(localAppData || "", "Programs", "TorPlay");
  const resolvedData = dataDir || path.join(localAppData || "", "TorPlay");
  return {
    installDir: resolvedInstall,
    dataDir: resolvedData,
    configPath: path.join(resolvedData, "config", "torplay.env"),
    databasePath: path.join(resolvedData, "data", "torplay.db"),
    torrentPath: path.join(resolvedData, "cache", "torrents"),
    subtitlePath: path.join(resolvedData, "cache", "subtitles"),
    runtimeDir: path.join(resolvedData, "runtime"),
    lockPath: path.join(resolvedData, "runtime", "home.lock"),
    statusPath: path.join(resolvedData, "runtime", "status.json"),
    logPath: path.join(resolvedData, "logs", "torplay.log"),
    serverEntry: path.join(resolvedInstall, "app", "server.js"),
    homeEntry: path.join(resolvedInstall, "runtime", "home.mjs"),
    watchdogEntry: path.join(resolvedInstall, "runtime", "runtime-watchdog.mjs"),
    runnerEntry: path.join(resolvedInstall, "runtime", "windows-runner.mjs"),
    controlEntry: path.join(resolvedInstall, "runtime", "windows-control.mjs"),
    launcherPath: path.join(resolvedInstall, "runtime", "torplay-launcher.vbs"),
    trayScriptPath: path.join(resolvedInstall, "runtime", "torplay-tray.ps1"),
    trayLauncherPath: path.join(resolvedInstall, "runtime", "torplay-tray.vbs"),
    trayPidPath: path.join(resolvedData, "runtime", "tray.pid"),
    nodePath: path.join(resolvedInstall, "runtime", "node.exe"),
  };
}

export function installedEnvironment(paths, environment = process.env) {
  return {
    ...environment,
    NODE_ENV: "production",
    TORPLAY_INSTALL_DIR: paths.installDir,
    TORPLAY_DATA_DIR: paths.dataDir,
    TORPLAY_CONFIG_PATH: environment.TORPLAY_CONFIG_PATH || paths.configPath,
    TORPLAY_DEFAULT_DATABASE_PATH: paths.databasePath,
    TORPLAY_DEFAULT_TORRENT_PATH: paths.torrentPath,
    TORPLAY_DEFAULT_SUBTITLE_PATH: paths.subtitlePath,
    TORPLAY_RUNTIME_DIR: environment.TORPLAY_RUNTIME_DIR || paths.runtimeDir,
    TORPLAY_STATUS_PATH: environment.TORPLAY_STATUS_PATH || paths.statusPath,
    TORPLAY_LOG_PATH: environment.TORPLAY_LOG_PATH || paths.logPath,
    TORPLAY_SERVER_ENTRY: environment.TORPLAY_SERVER_ENTRY || paths.serverEntry,
    TORPLAY_WATCHDOG_ENTRY: environment.TORPLAY_WATCHDOG_ENTRY || paths.watchdogEntry,
  };
}
