const CLOSE_KEYS = new Set(["ArrowLeft", "Backspace", "BrowserBack", "Escape", "GoBack"]);

export function nextMenuIndex(currentIndex, itemCount, key) {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") {
    return currentIndex >= 0 && currentIndex < itemCount - 1 ? currentIndex + 1 : 0;
  }
  if (key === "ArrowUp") {
    return currentIndex > 0 && currentIndex < itemCount ? currentIndex - 1 : itemCount - 1;
  }
  return -1;
}

export function closesPlayerMenu(key) {
  return CLOSE_KEYS.has(key);
}
