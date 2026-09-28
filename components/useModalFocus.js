"use client";

import { useEffect, useEffectEvent } from "react";
import { normalizeRemoteKey } from "../lib/ui/spatial-navigation.js";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function useModalFocus(ref, active, onClose, blocked = false) {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => ref.current?.querySelector(FOCUSABLE)?.focus());
    function keydown(event) {
      const key = normalizeRemoteKey(event.key, event.keyCode);
      if ((key === "Escape" || key === "Back") && !blocked) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(ref.current?.querySelectorAll(FOCUSABLE) || [])];
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [active, blocked, ref]);
}
