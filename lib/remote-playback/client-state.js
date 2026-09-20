const activeSessionsKey = Symbol.for("torplay.remotePlaybackSessions");

function activeSessions() {
  globalThis[activeSessionsKey] ??= new Set();
  return globalThis[activeSessionsKey];
}

export function setRemotePlaybackSessionActive(sessionId, active) {
  if (!sessionId) return;
  if (active) activeSessions().add(sessionId);
  else activeSessions().delete(sessionId);
}

export function isRemotePlaybackSessionActive(sessionId) {
  return Boolean(sessionId && activeSessions().has(sessionId));
}
