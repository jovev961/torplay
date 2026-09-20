"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./copyText.js";
import styles from "./SettingsManager.module.css";

async function readNetworkAccess(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.hostnameUrl) {
    throw new Error(data?.error || "Network addresses could not be detected.");
  }
  return data;
}

function AddressRow({ id, label, url, copied, onCopy }) {
  return (
    <div className={styles.networkAddress}>
      <div>
        <strong>{label}</strong>
        <code>{url}</code>
      </div>
      <button type="button" onClick={() => onCopy(id, url)}>
        {copied === id ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function NetworkAccess() {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const copyTimerRef = useRef(null);

  const refresh = useCallback(async (signal) => {
    try {
      const data = await readNetworkAccess(await fetch("/api/network-access", {
        cache: "no-store",
        signal,
      }));
      setDetails(data);
      setError("");
    } catch (refreshError) {
      if (refreshError.name !== "AbortError") setError(refreshError.message);
    }
  }, []);

  useEffect(() => {
    let controller = new AbortController();
    const update = () => {
      controller.abort();
      controller = new AbortController();
      void refresh(controller.signal);
    };
    const updateWhenVisible = () => {
      if (document.visibilityState === "visible") update();
    };

    update();
    const interval = setInterval(updateWhenVisible, 30_000);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", updateWhenVisible);
    return () => {
      controller.abort();
      clearInterval(interval);
      clearTimeout(copyTimerRef.current);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", updateWhenVisible);
    };
  }, [refresh]);

  async function handleCopy(id, url) {
    try {
      await copyText(url);
      clearTimeout(copyTimerRef.current);
      setCopied(id);
      setError("");
      copyTimerRef.current = setTimeout(() => setCopied(""), 2_000);
    } catch (copyError) {
      setError(copyError.message);
    }
  }

  return (
    <article className={styles.networkAccessCard}>
      <div className={styles.networkAccessHeading}>
        <div>
          <h3>Network Access</h3>
          <p>Open TorPlay from a TV, phone, or tablet on the same local network.</p>
        </div>
        {!details && !error ? <span>Detecting…</span> : null}
      </div>

      {details ? (
        <div className={styles.networkAccessLayout}>
          <div className={styles.networkAddressList} aria-live="polite">
            <AddressRow
              id="hostname"
              label="This computer"
              url={details.hostnameUrl}
              copied={copied}
              onCopy={handleCopy}
            />
            {details.lanUrl ? (
              <AddressRow
                id="lan"
                label="Local network"
                url={details.lanUrl}
                copied={copied}
                onCopy={handleCopy}
              />
            ) : (
              <div className={styles.networkUnavailable}>
                <strong>Local network</strong>
                <span>No local network address detected.</span>
              </div>
            )}
            <p>Use the local network address on devices that cannot open <code>torplay.local</code>.</p>
          </div>
          {details.lanUrl ? (
            <div className={styles.networkQrCode}>
              <QRCodeSVG value={details.lanUrl} size={156} level="M" marginSize={2} title="TorPlay local network address" />
              <span>Scan to open TorPlay</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className={styles.networkAccessError} role="alert">{error}</p> : null}
    </article>
  );
}
