import http from "node:http";
import { getResponder, ServiceEvent, ServiceType } from "@homebridge/ciao";
import { createProxyServer as createDefaultProxyServer } from "http-proxy-3";
import { isPrivateNetworkAddress } from "../lib/network/private-address.js";

export const isPrivateClientAddress = isPrivateNetworkAddress;

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeServer(server, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      server.closeAllConnections?.();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

export async function startReverseProxy({
  targetHost,
  targetPort,
  publicPort,
  publicHost = "0.0.0.0",
  createProxyServer = createDefaultProxyServer,
  createHttpServer = http.createServer,
} = {}) {
  const target = `http://${targetHost}:${targetPort}`;
  const proxy = createProxyServer({ target, xfwd: true, changeOrigin: false });
  const server = createHttpServer((request, response) => {
    if (!isPrivateClientAddress(request.socket.remoteAddress)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("TorPlay is available only on the private local network.\n");
      return;
    }
    proxy.web(request, response, (error) => {
      console.error(`[proxy] ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (!response.writableEnded) response.end("TorPlay is temporarily unavailable.\n");
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  try {
    await listen(server, publicPort, publicHost);
  } catch (error) {
    proxy.removeAllListeners?.();
    throw error;
  }

  return {
    server,
    isHealthy() {
      return server.listening;
    },
    async stop() {
      await closeServer(server);
      proxy.removeAllListeners?.();
    },
  };
}

function hostnameLabel(hostname) {
  return hostname.toLowerCase().replace(/\.local\.?$/, "").replace(/\.$/, "");
}

function normalizedHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export async function startMdnsAdvertisement({
  hostname,
  port,
  mdnsInterface,
  responderFactory = getResponder,
} = {}) {
  const responder = responderFactory({
    advertiseIpv4: true,
    advertiseIpv6: false,
    disableIpv6: true,
    ...(mdnsInterface ? { interface: mdnsInterface } : {}),
  });
  const service = responder.createService({
    name: "TorPlay",
    type: ServiceType.HTTP,
    hostname: hostnameLabel(hostname),
    port,
    disabledIpv6: true,
    txt: { path: "/" },
  });
  let hostnameChanged = false;
  service.once(ServiceEvent.HOSTNAME_CHANGED, () => {
    hostnameChanged = true;
  });

  try {
    await service.advertise();
    const advertised = normalizedHostname(service.getHostname());
    if (hostnameChanged || advertised !== normalizedHostname(hostname)) {
      throw new Error(`${hostname} is already in use on this network.`);
    }
  } catch (error) {
    await responder.shutdown().catch(() => {});
    throw error;
  }

  let stopped = false;
  return {
    service,
    isHealthy() {
      return !stopped && (!service.serviceState || service.serviceState === "announced");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await responder.shutdown();
    },
  };
}
