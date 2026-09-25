export const NEXT_EPISODE_PROMPT_SECONDS = 120;
export const FALLBACK_UP_NEXT_SECONDS = 30;
export const PLAYBACK_END_TOLERANCE_SECONDS = 5;

function validTimeline(position, duration) {
  return Number.isFinite(position) && position >= 0
    && Number.isFinite(duration) && duration > 0;
}

export function upNextTrigger(duration, outro = null) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return outro && Number.isFinite(outro.start) && outro.start >= 0 && outro.start < duration
    ? outro.start : Math.max(0, duration - FALLBACK_UP_NEXT_SECONDS);
}

export function shouldShowUpNext(position, duration, outro = null) {
  const trigger = upNextTrigger(duration, outro);
  return validTimeline(position, duration) && trigger !== null && position >= trigger;
}

export function shouldOfferNextEpisode(position, duration, outro = null) {
  if (!validTimeline(position, duration)) return false;
  return position >= Math.min(Math.max(0, duration - NEXT_EPISODE_PROMPT_SECONDS), upNextTrigger(duration, outro));
}

export function isPlaybackAtEnd(position, duration) {
  if (!validTimeline(position, duration)) return false;
  return duration - position <= PLAYBACK_END_TOLERANCE_SECONDS;
}

export function autoplayReducer(state, action) {
  if (action.type === "reset") return { phase: "idle", endReached: false };
  if (action.type === "resolving") {
    return { phase: "resolving", endReached: Boolean(action.endReached) };
  }
  if (action.type === "ended" && !["cancelled", "end"].includes(state.phase)) {
    return { ...state, endReached: true };
  }
  if (action.type === "ready") {
    if (state.phase !== "resolving") return state;
    return { phase: "ready", endReached: Boolean(state.endReached), ...action.payload };
  }
  if (action.type === "advancing" && state.phase === "ready") {
    return { ...state, phase: "advancing" };
  }
  if (action.type === "cancel") return { phase: "cancelled", endReached: false };
  if (action.type === "manual") {
    if (!["resolving", "advancing"].includes(state.phase)) return state;
    return { phase: "manual", endReached: Boolean(state.endReached), ...action.payload };
  }
  if (action.type === "end") return { phase: "end" };
  return state;
}
