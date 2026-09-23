import { randomUUID } from "node:crypto";
import { readDebridConfig, updateDebridConfig } from "./config.js";
import { makeDebridProvider, stopProviderSessions } from "./session.js";
import {
  finishRealDebridAuthorization, startRealDebridAuthorization,
} from "./real-debrid.js";
import { finishTorBoxAuthorization, startTorBoxAuthorization } from "./torbox.js";

const flowKey = Symbol.for("torplay.debridAuthFlows");
function flows() {
  globalThis[flowKey] ??= new Map();
  return globalThis[flowKey];
}

export async function beginDebridAuthorization(providerId, fetchImpl = globalThis.fetch) {
  const data = providerId === "real-debrid"
    ? await startRealDebridAuthorization(fetchImpl)
    : await startTorBoxAuthorization(fetchImpl);
  const deviceCode = data?.device_code;
  const userCode = providerId === "real-debrid" ? data?.user_code : data?.code;
  if (!deviceCode || !userCode || !data?.verification_url) {
    throw new Error("The provider returned an invalid authorization code.");
  }
  const id = randomUUID();
  const interval = Math.max(3, Number(data.interval) || 5);
  const expiresAt = Date.now() + Math.min(1800, Number(data.expires_in) || 600) * 1000;
  flows().set(id, { providerId, deviceCode, expiresAt, nextPollAt: 0, interval });
  return { id, userCode, verificationUrl: data.verification_url, interval, expiresAt };
}

export async function pollDebridAuthorization(providerId, flowId, fetchImpl = globalThis.fetch) {
  const flow = flows().get(flowId);
  if (!flow || flow.providerId !== providerId || Date.now() > flow.expiresAt) {
    flows().delete(flowId);
    return { status: "expired" };
  }
  if (Date.now() < flow.nextPollAt) return { status: "connecting" };
  flow.nextPollAt = Date.now() + flow.interval * 1000;
  let credential;
  try {
    credential = providerId === "real-debrid"
      ? await finishRealDebridAuthorization(flow.deviceCode, fetchImpl)
      : { apiKey: await finishTorBoxAuthorization(flow.deviceCode, fetchImpl) };
  } catch (error) {
    if (["provider-error", "authentication"].includes(error.code)) return { status: "connecting" };
    throw error;
  }
  await updateDebridConfig((config) => ({
    ...config, credentials: { ...config.credentials, [providerId]: credential },
  }));
  flows().delete(flowId);
  return { status: "connected" };
}

export async function connectTorBoxApiKey(apiKey, fetchImpl = globalThis.fetch) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
    throw Object.assign(new Error("Enter a valid TorBox API key."), { status: 400 });
  }
  const credential = { apiKey: apiKey.trim() };
  await new (await import("./torbox.js")).TorBoxProvider(credential, { fetchImpl }).testConnection();
  await updateDebridConfig((config) => ({
    ...config, credentials: { ...config.credentials, torbox: credential },
  }));
  return { status: "connected" };
}

export async function testDebridConnection(providerId) {
  const config = await readDebridConfig();
  const credential = config.credentials[providerId];
  if (!credential) return { status: "not-configured" };
  try {
    await makeDebridProvider(providerId, credential).testConnection();
    return { status: "connected" };
  } catch (error) {
    return { status: error.code === "authentication" ? "authentication-required"
      : error.code === "rate-limited" ? "rate-limited" : "unavailable" };
  }
}

export async function disconnectDebrid(providerId) {
  const config = await readDebridConfig();
  const credential = config.credentials[providerId];
  await stopProviderSessions(providerId);
  if (providerId === "real-debrid" && credential) {
    await makeDebridProvider(providerId, credential).disconnect();
  }
  await updateDebridConfig((current) => {
    const credentials = { ...current.credentials };
    delete credentials[providerId];
    return { ...current, credentials };
  });
  for (const [id, flow] of flows()) if (flow.providerId === providerId) flows().delete(id);
  return { status: "not-configured" };
}
