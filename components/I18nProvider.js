"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, displayLanguage, formatDate, formatNumber } from "../lib/i18n/index.js";
import { LOCALE_COOKIE, normalizeLocale } from "../lib/i18n/locales.js";

const I18nContext = createContext(null);
const textState = new WeakMap();
const attributeState = new WeakMap();
const translatedAttributes = ["aria-label", "placeholder", "title"];

function translateTextNode(node, locale, t) {
  const current = node.data;
  let state = textState.get(node);
  if (locale === "en") {
    if (state && current === state.translated) node.data = state.original;
    textState.delete(node);
    return;
  }
  if (state && current !== state.translated) state = null;
  const match = current.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const original = state?.original ?? current;
  const core = match?.[2] || "";
  if (!core) return;
  const translatedCore = t(core);
  if (translatedCore === core) return;
  const translated = `${match[1]}${translatedCore}${match[3]}`;
  textState.set(node, { original, translated });
  node.data = translated;
}

function translateElementAttributes(element, locale, t) {
  let states = attributeState.get(element);
  for (const name of translatedAttributes) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name);
    const previous = states?.get(name);
    if (locale === "en") {
      if (previous && current === previous.translated) element.setAttribute(name, previous.original);
      states?.delete(name);
      continue;
    }
    const original = previous && current === previous.translated ? previous.original : current;
    const translated = t(original);
    if (translated === original) continue;
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    states.set(name, { original, translated });
    if (current !== translated) element.setAttribute(name, translated);
  }
}

function translateTree(root, locale, t) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root, locale, t);
    return;
  }
  if (!(root instanceof Element) && root !== document.body) return;
  if (root instanceof Element) translateElementAttributes(root, locale, t);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, locale, t);
    else translateElementAttributes(node, locale, t);
    node = walker.nextNode();
  }
}

export function I18nProvider({ children, initialLocale = "en" }) {
  const router = useRouter();
  const [locale, setLocaleState] = useState(normalizeLocale(initialLocale));
  const [, startTransition] = useTransition();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const setLocale = useCallback((nextLocale) => {
    const next = normalizeLocale(nextLocale);
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = next;
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    document.documentElement.lang = locale;
    translateTree(document.body, locale, t);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") translateTextNode(record.target, locale, t);
        else if (record.type === "attributes") translateElementAttributes(record.target, locale, t);
        else for (const node of record.addedNodes) translateTree(node, locale, t);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: translatedAttributes });
    return () => observer.disconnect();
  }, [locale, t]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    t,
    formatNumber: (value, options) => formatNumber(locale, value, options),
    formatDate: (value, options) => formatDate(locale, value, options),
    displayLanguage: (code) => displayLanguage(locale, code),
  }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}

export function useOptionalI18n() {
  return useContext(I18nContext);
}
