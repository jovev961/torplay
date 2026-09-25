function standardFullscreenElement(documentRef) {
  return documentRef?.fullscreenElement || documentRef?.webkitFullscreenElement || null;
}

export function isFullscreenActive(documentRef, player, video) {
  const activeElement = standardFullscreenElement(documentRef);
  return Boolean(activeElement && (activeElement === player || activeElement === video))
    || Boolean(video?.webkitDisplayingFullscreen);
}

export function supportsFullscreen(player, { viewportFallback = false } = {}) {
  return typeof player?.requestFullscreen === "function"
    || typeof player?.webkitRequestFullscreen === "function"
    || viewportFallback;
}

export function needsHomeScreenForImmersivePlayback(navigatorRef, displayModeMatches = false) {
  return /iPhone|iPod/i.test(navigatorRef?.userAgent || "")
    && navigatorRef?.standalone !== true && !displayModeMatches;
}

export function lockFullscreenViewport(documentRef) {
  const root = documentRef?.documentElement;
  const body = documentRef?.body;
  if (!root || !body) return () => {};

  const previous = {
    rootOverflow: root.style.overflow,
    rootOverscrollBehavior: root.style.overscrollBehavior,
    bodyOverflow: body.style.overflow,
    bodyOverscrollBehavior: body.style.overscrollBehavior,
  };
  root.style.overflow = "hidden";
  root.style.overscrollBehavior = "none";
  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "none";

  return () => {
    root.style.overflow = previous.rootOverflow;
    root.style.overscrollBehavior = previous.rootOverscrollBehavior;
    body.style.overflow = previous.bodyOverflow;
    body.style.overscrollBehavior = previous.bodyOverscrollBehavior;
  };
}

async function enterViewportFallback(enterViewport, originalError = null) {
  if (typeof enterViewport === "function") {
    await enterViewport();
    return "enter";
  }
  if (originalError) throw originalError;
  throw new Error("This browser does not support fullscreen playback.");
}

export async function toggleBrowserFullscreen(
  documentRef,
  player,
  {
    viewportActive = false,
    enterViewport = null,
    exitViewport = null,
  } = {},
) {
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

  if (viewportActive) {
    if (typeof exitViewport !== "function") {
      throw new Error("This browser cannot exit fullscreen playback.");
    }
    await exitViewport();
    return "exit";
  }

  if (typeof player?.requestFullscreen === "function") {
    try {
      await player.requestFullscreen();
      return "enter";
    } catch (error) {
      return enterViewportFallback(enterViewport, error);
    }
  }
  if (typeof player?.webkitRequestFullscreen === "function") {
    try {
      await player.webkitRequestFullscreen();
      return "enter";
    } catch (error) {
      return enterViewportFallback(enterViewport, error);
    }
  }

  return enterViewportFallback(enterViewport);
}
