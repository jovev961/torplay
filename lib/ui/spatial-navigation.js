const BACK_KEYS = new Set(["BrowserBack", "GoBack"]);

export function normalizeRemoteKey(key, keyCode = 0) {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(key)) return key;
  if (BACK_KEYS.has(key) || keyCode === 10009 || keyCode === 461) return "Back";
  return key;
}

export function directionalCandidate(origin, candidates, direction) {
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  const sign = direction === "ArrowLeft" || direction === "ArrowUp" ? -1 : 1;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate.element === origin.element) continue;
    const primary = horizontal
      ? (candidate.x - origin.x) * sign
      : (candidate.y - origin.y) * sign;
    if (primary <= 1) continue;
    const cross = Math.abs(horizontal ? candidate.y - origin.y : candidate.x - origin.x);
    const score = primary + (cross * 2.25);
    if (score < bestScore) {
      best = candidate.element;
      bestScore = score;
    }
  }
  return best;
}

export function isEditableArrowTarget(element, direction) {
  if (!element) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") {
    const type = String(element.type || "text").toLowerCase();
    if (type === "range") return direction === "ArrowLeft" || direction === "ArrowRight";
    return direction === "ArrowLeft" || direction === "ArrowRight";
  }
  return element.tagName === "SELECT";
}
