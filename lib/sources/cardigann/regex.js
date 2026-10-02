import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { SourceError } from "../contract.js";

const executions = new AsyncLocalStorage();
const timeout = () => new SourceError("CARDIGANN_REGEX_TIMEOUT", "Source regular-expression processing timed out.", 504);
const unsupported = () => new SourceError("CARDIGANN_UNSUPPORTED", "The regular expression exceeds supported processing limits.");

export function validateRegex(pattern, flags = "gi") {
  if (typeof pattern !== "string" || pattern.length > 4096) throw unsupported();
  try { new RegExp(pattern, flags); }
  catch { throw new SourceError("CARDIGANN_UNSUPPORTED", "The regular expression uses unsupported syntax."); }
}

// One lazily created worker per source execution, also used during private
// download resolution. Cancellation terminates it even during backtracking.
export async function withRegexExecution(operation, signal) {
  signal?.throwIfAborted();
  const state = { signal, worker: null, pending: null, closed: false, tail: Promise.resolve() };
  const stop = (error) => {
    state.closed = true;
    state.pending?.(error);
    return state.termination ??= state.worker?.terminate();
  };
  state.stop = stop;
  const abort = () => { void stop(signal.reason); };
  signal?.addEventListener("abort", abort, { once: true });
  try { return await executions.run(state, operation); }
  finally {
    signal?.removeEventListener("abort", abort);
    await stop(timeout());
  }
}

export async function executeRegex(input, pattern, { flags = "gi", replacement } = {}) {
  const state = executions.getStore();
  if (!state) return withRegexExecution(() => executeRegex(input, pattern, { flags, replacement }));
  const task = state.tail.then(() => runRegex(state, input, pattern, flags, replacement));
  state.tail = task.catch(() => {});
  return task;
}

function runRegex(state, input, pattern, flags, replacement) {
  state.signal?.throwIfAborted();
  if (state.closed) throw timeout();
  validateRegex(pattern, flags);
  // Bound transfer and worst-case replacement allocation as well as CPU.
  if (input.length > 5 * 1024 * 1024 || (replacement !== undefined
    && (replacement.length > 4096 || (input.length + 1) * (replacement.length
      + (replacement.includes("$") ? input.length : 0) + 1) > 16 * 1024 * 1024))) throw unsupported();
  if (!state.worker) {
    state.worker = new Worker(new URL("./regex-worker.mjs", import.meta.url), {
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
  }
  const worker = state.worker;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, result) => {
      clearTimeout(timer);
      worker.off("message", message);
      worker.off("error", failed);
      worker.off("exit", exited);
      worker.off("online", online);
      state.pending = null;
      if (error) reject(error); else resolve(result);
    };
    const failed = () => { finish(unsupported()); void state.stop(unsupported()); };
    const exited = () => finish(unsupported());
    const expired = () => { finish(timeout()); void state.stop(timeout()); };
    const message = ({ invalid, result }) => finish(invalid ? unsupported() : null, result);
    const online = () => {
      clearTimeout(timer);
      timer = setTimeout(expired, 50);
      worker.postMessage({ input, pattern, flags, replacement });
    };
    state.pending = finish;
    worker.once("message", message);
    worker.once("error", failed);
    worker.once("exit", exited);
    if (state.started) online();
    else {
      timer = setTimeout(expired, 1000);
      worker.once("online", () => { state.started = true; });
      worker.once("online", online);
    }
  });
}
