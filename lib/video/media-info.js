import { getInternalFileUrl } from "../torrent/manager.js";
import { getRemoteInternalFileUrl } from "../debrid/session.js";
import { extractEmbeddedSubtitle, probeVideoFile } from "./transcode.js";
import { audioTrackByIndex, selectAudioTrack } from "./audio-tracks.js";
import { verifiedMediaBadges } from "./media-capabilities.js";

export async function getMediaInfo(session, file) {
  const fileId = String(session.resource.torrent.files.indexOf(file));
  const probes = session.resource.mediaProbes;
  let probe = probes.get(fileId);
  if (!probe) {
    const inputUrl = session.backend === "debrid"
      ? await getRemoteInternalFileUrl(session, file)
      : getInternalFileUrl(session, file);
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
  return async (_media, streamIndex) => {
    const inputUrl = session.backend === "debrid"
      ? await getRemoteInternalFileUrl(session, file)
      : getInternalFileUrl(session, file);
    return extractEmbeddedSubtitle(inputUrl, streamIndex, {
      context: `session=${session.id} embedded=${streamIndex} name=${file.name}`,
    });
  };
}

export function mediaDescriptor(file, playbackMode, media, selectedAudioStreamIndex = null, sourceMimeType = null) {
  const multiAudio = media.audioStreams?.length > 1;
  const selectedAudio = audioTrackByIndex(media.audioStreams, selectedAudioStreamIndex)
    || selectAudioTrack(media.audioStreams);
  return {
    duration: media.duration,
    container: media.container,
    sourceMimeType: sourceMimeType || file.sourceMimeType || file.mimeType || "application/octet-stream",
    videoCodec: media.videoCodec,
    video: media.video || null,
    audioCodec: selectedAudio?.codec || media.audioCodec,
    audioTracks: media.audioStreams || [],
    badges: verifiedMediaBadges(media, selectedAudio?.index ?? null),
    selectedAudioStreamIndex,
    directPlay: playbackMode === "native" && !multiAudio,
    rangeSupported: true,
    hlsAvailable: playbackMode === "transcode" || multiAudio,
    size: file.length,
  };
}
