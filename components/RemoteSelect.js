"use client";

import { useEffect, useId, useRef, useState } from "react";

export default function RemoteSelect({ id, value, options, onChange, disabled = false, ariaLabel }) {
  const generatedId = useId();
  const listId = `${id || generatedId}-options`;
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));

  function focusOption(index = selectedIndex) {
    requestAnimationFrame(() => {
      rootRef.current?.querySelectorAll('[role="option"]')[index]?.focus();
    });
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (event.type === "pointerdown" && !rootRef.current?.contains(event.target)) close(false);
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", outside);
    };
  }, [open]);

  const selected = options[selectedIndex] || options[0];
  return (
    <div className="remoteSelect" ref={rootRef}>
      <button
        id={id}
        className="remoteSelectTrigger"
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((current) => !current);
          if (!open) focusOption();
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
            focusOption();
          }
        }}
      >
        <span>{selected?.label || ""}</span><span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="remoteSelectMenu" id={listId} role="listbox" data-focus-scope="active"
          aria-label={ariaLabel} onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll('[role="option"]')];
            const current = items.indexOf(document.activeElement);
            let next = -1;
            if (event.key === "ArrowDown") next = (current + 1) % items.length;
            if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = items.length - 1;
            if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
          }}>
          {options.map((option) => (
            <button type="button" role="option" aria-selected={String(option.value) === String(value)}
              disabled={option.disabled} key={String(option.value)}
              onClick={() => { onChange(option.value); close(); }}>
              <span>{option.label}</span>{String(option.value) === String(value) ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
