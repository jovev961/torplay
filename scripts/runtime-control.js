import net from "node:net";
import path from "node:path";

export function controlEndpoint(environment = process.env, platform = process.platform) {
  if (environment.TORPLAY_CONTROL_ENDPOINT) return environment.TORPLAY_CONTROL_ENDPOINT;
  return platform === "win32"
    ? "\\\\.\\pipe\\torplay-home-runtime"
    : path.join(environment.TORPLAY_RUNTIME_DIR || "/tmp", "torplay-control.sock");
}

export function startControlServer({ endpoint = controlEndpoint(), onStop } = {}) {
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      if (input.trim() !== "stop") {
        socket.end("ERROR Unsupported command\n");
        return;
      }
      socket.end("OK stopping\n");
      void onStop?.();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve({
      server,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

export function sendControlCommand({
  endpoint = controlEndpoint(),
  command = "stop",
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TorPlay control request timed out."));
    }, timeoutMs);
    timer.unref?.();
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (output.startsWith("OK")) resolve(output.trim());
      else reject(new Error(output.trim() || "TorPlay control channel is unavailable."));
    });
  });
}
