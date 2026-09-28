"use client";

import { useEffect } from "react";
import {
  directionalCandidate,
  isEditableArrowTarget,
  normalizeRemoteKey,
} from "../lib/ui/spatial-navigation.js";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function visible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function activeScope() {
  const modals = [...document.querySelectorAll(
    '[aria-modal="true"], [data-focus-scope="active"], [role="menu"], .playerMenu',
  )]
    .filter(visible);
  return modals.at(-1) || document;
}

function focusables(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(visible);
}

function point(element) {
  const rect = element.getBoundingClientRect();
  return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function overlayOpen() {
  return Boolean(document.querySelector(
    '[aria-modal="true"], [role="menu"], .playerMenu, .profileMenu, .mainNav.open',
  ));
}

export default function TvNavigation() {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = normalizeRemoteKey(event.key, event.keyCode);
      if (key === "Back") {
        event.preventDefault();
        if (overlayOpen()) {
          (document.activeElement || document).dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape", bubbles: true, cancelable: true,
          }));
        } else if (window.history.length > 1) {
          window.history.back();
        }
        return;
      }
      if (!key.startsWith("Arrow") || isEditableArrowTarget(event.target, key)) return;
      const scope = activeScope();
      const items = focusables(scope);
      if (!items.length) return;
      const current = items.includes(document.activeElement) ? document.activeElement : null;
      const target = current
        ? directionalCandidate(point(current), items.map(point), key)
        : items[0];
      if (!target) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
  return null;
}
