export const GOOGLE_CAST_SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

export function createCastLoadRequest(castApi, source) {
  const media = castApi.media;
  const mediaInfo = new media.MediaInfo(source.url, source.contentType);
  mediaInfo.streamType = media.StreamType.BUFFERED;

  const metadata = new media.GenericMediaMetadata();
  metadata.title = source.title;
  if (source.posterUrl) metadata.images = [new castApi.Image(source.posterUrl)];
  mediaInfo.metadata = metadata;

  const trackIds = new Map();
  mediaInfo.tracks = source.subtitles.map((subtitle, index) => {
    const id = index + 1;
    trackIds.set(subtitle.id, id);
    const track = new media.Track(id, media.TrackType.TEXT);
    track.trackContentId = subtitle.url;
    track.trackContentType = "text/vtt";
    track.subtype = media.TextTrackType.SUBTITLES;
    track.name = subtitle.label;
    track.language = subtitle.language;
    return track;
  });

  const request = new media.LoadRequest(mediaInfo);
  request.currentTime = source.receiverStartTime;
  const activeTrack = trackIds.get(source.activeSubtitleId);
  if (activeTrack) request.activeTrackIds = [activeTrack];
  return request;
}

export function castTimeline(source, remotePlayer) {
  const remotePosition = Number(remotePlayer?.currentTime);
  const remoteDuration = Number(remotePlayer?.duration);
  const originSeconds = Number(source?.originSeconds) || 0;
  return {
    position: originSeconds + (Number.isFinite(remotePosition) ? Math.max(0, remotePosition) : 0),
    duration: Number(source?.duration) > 0
      ? Number(source.duration)
      : originSeconds + (Number.isFinite(remoteDuration) ? Math.max(0, remoteDuration) : 0),
  };
}
