import { getInternalFileUrl } from "../torrent/manager.js";
import { extractEmbeddedSubtitle, probeVideoFile } from "./transcode.js";

export function getMediaInfo(session, file) {
  const fileId = String(session.resource.torrent.files.indexOf(file));
  const probes = session.resource.mediaProbes;
  let probe = probes.get(fileId);
  if (!probe) {
    const inputUrl = getInternalFileUrl(session, file);
    probe = probeVideoFile(file, {
      inputUrl,
      context: `torrent=${session.infoHash} file=${fileId} name=${file.name}`,
    }).catch((error) => {
      if (probes.get(fileId) === probe) probes.delete(fileId);
      throw error;
    });
    probes.set(fileId, probe);
  }
  return probe;
}

export function embeddedSubtitleExtractor(session, file) {
  const inputUrl = getInternalFileUrl(session, file);
  return (_media, streamIndex) => extractEmbeddedSubtitle(inputUrl, streamIndex, {
    context: `torrent=${session.infoHash} embedded=${streamIndex} name=${file.name}`,
  });
}

export function mediaDescriptor(file, playbackMode, media) {
  return {
    duration: media.duration,
    container: media.container,
    videoCodec: media.videoCodec,
    audioCodec: media.audioCodec,
    directPlay: playbackMode === "native",
    rangeSupported: true,
    hlsAvailable: playbackMode === "transcode",
    size: file.length,
  };
}
