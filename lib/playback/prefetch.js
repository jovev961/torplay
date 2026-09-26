import {
  cancelVideoFilePrefetch,
  getVideoFilePrefetch,
  prefetchVideoFile,
} from "../torrent/manager.js";

export const PREFETCH_MAX_BYTES = 64 * 1024 * 1024;

export function publicPrefetchStatus(status) {
  return status || { state: "idle" };
}

export function startVideoFilePrefetch(session, file) {
  const targetBytes = Math.min(file.length, PREFETCH_MAX_BYTES);
  const status = prefetchVideoFile(session, file, targetBytes);
  return publicPrefetchStatus(status
    || { state: "failed", fileId: null, targetBytes: 0, downloadedBytes: 0 });
}

export function readVideoFilePrefetch(session, file) {
  return publicPrefetchStatus(getVideoFilePrefetch(session, file));
}

export function stopVideoFilePrefetch(session, file) {
  const cancelled = cancelVideoFilePrefetch(session, file);
  return { state: "idle", cancelled };
}
