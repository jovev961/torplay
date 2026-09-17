import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export function controlEndpoint(
  environment = process.env,
  platform = process.platform,
) {
  if (environment.TORPLAY_CONTROL_ENDPOINT) {
    return environment.TORPLAY_CONTROL_ENDPOINT;
  }

  return platform === "win32"
    ? `${WINDOWS_PIPE_PREFIX}torplay-home-runtime`
    : path.join(
        environment.TORPLAY_RUNTIME_DIR || "/tmp",
        "torplay-control.sock",
      );
}

/*
 * Windows cannot listen on Unix-style filesystem sockets such as:
 *
 *   C:\\Users\\...\\control.sock
 *
 * Node expects a Windows named pipe instead:
 *
 *   \\\\.\\pipe\\torplay-control-...
 *
 * Tests and callers may explicitly provide a filesystem-style endpoint,
 * so convert it into a deterministic named pipe on Windows.
 *
 * The same input always produces the same pipe name, allowing the server
 * and client to resolve the endpoint independently.
 */
export function normalizeControlEndpoint(
  endpoint,
  platform = process.platform,
) {
  if (platform !== "win32") {
    return endpoint;
  }

  if (
    typeof endpoint === "string" &&
    endpoint.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX.toLowerCase())
  ) {
    return endpoint;
  }

  const source = String(endpoint || "torplay-home-runtime");

  const id = createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 16);

  return `${WINDOWS_PIPE_PREFIX}torplay-control-${id}`;
}

export function startControlServer({
  endpoint = controlEndpoint(),
  onStop,
} = {}) {
  const resolvedEndpoint = normalizeControlEndpoint(endpoint);

  const server = net.createServer((socket) => {
    let input = "";

    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      input += chunk;

      if (!input.includes("\n")) {
        return;
      }

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

    server.listen(resolvedEndpoint, () => {
      resolve({
        server,
        endpoint: resolvedEndpoint,
        close: () =>
          new Promise((done) => {
            server.close(done);
          }),
      });
    });
  });
}

export function sendControlCommand({
  endpoint = controlEndpoint(),
  command = "stop",
  timeoutMs = 5_000,
} = {}) {
  const resolvedEndpoint = normalizeControlEndpoint(endpoint);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(resolvedEndpoint);

    let settled = false;
    let output = "";

    const finishReject = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const finishResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      socket.destroy();

      finishReject(
        new Error("TorPlay control request timed out."),
      );
    }, timeoutMs);

    timer.unref?.();

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(`${command}\n`);
    });

    socket.on("data", (chunk) => {
      output += chunk;
    });

    socket.on("error", (error) => {
      finishReject(error);
    });

    socket.on("close", () => {
      if (settled) {
        return;
      }

      if (output.startsWith("OK")) {
        finishResolve(output.trim());
        return;
      }

      finishReject(
        new Error(
          output.trim() ||
            "TorPlay control channel is unavailable.",
        ),
      );
    });
  });
}