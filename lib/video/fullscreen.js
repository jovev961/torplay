function standardFullscreenElement(documentRef) {
  return documentRef?.fullscreenElement || documentRef?.webkitFullscreenElement || null;
}

export function isFullscreenActive(documentRef, player, video) {
  const activeElement = standardFullscreenElement(documentRef);
  return Boolean(activeElement && (activeElement === player || activeElement === video))
    || Boolean(video?.webkitDisplayingFullscreen);
}

export function supportsFullscreen(player, video) {
  if (
    typeof player?.requestFullscreen === "function"
    || typeof player?.webkitRequestFullscreen === "function"
    || typeof video?.requestFullscreen === "function"
  ) {
    return true;
  }

  return typeof video?.webkitEnterFullscreen === "function"
    && video.webkitSupportsFullscreen !== false;
}

export async function toggleBrowserFullscreen(documentRef, player, video) {
  const activeElement = standardFullscreenElement(documentRef);
  if (activeElement) {
    if (typeof documentRef?.exitFullscreen === "function") {
      await documentRef.exitFullscreen();
      return "exit";
    }
    if (typeof documentRef?.webkitExitFullscreen === "function") {
      await documentRef.webkitExitFullscreen();
      return "exit";
    }
    throw new Error("This browser cannot exit fullscreen playback.");
  }

  if (video?.webkitDisplayingFullscreen) {
    if (typeof video.webkitExitFullscreen === "function") {
      await video.webkitExitFullscreen();
      return "exit";
    }
    throw new Error("This browser cannot exit fullscreen playback.");
  }

  if (typeof player?.requestFullscreen === "function") {
    await player.requestFullscreen();
    return "enter";
  }
  if (typeof player?.webkitRequestFullscreen === "function") {
    await player.webkitRequestFullscreen();
    return "enter";
  }
  if (typeof video?.requestFullscreen === "function") {
    await video.requestFullscreen();
    return "enter";
  }
  if (
    typeof video?.webkitEnterFullscreen === "function"
    && video.webkitSupportsFullscreen !== false
  ) {
    await video.webkitEnterFullscreen();
    return "enter";
  }

  throw new Error("This browser does not support fullscreen playback.");
}
