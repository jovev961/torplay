"use client";

import Link from "next/link";
import { findEpisodeFile, findLargestFile } from "../lib/video/episode.js";
import { episodeFilePresentation, formatFileSize } from "../lib/video/episode-display.js";
import VideoPlayer from "./VideoPlayer.js";

function formatSpeed(value) {
  return Number.isFinite(value) && value > 0 ? `${formatFileSize(value)}/s` : "0 B/s";
}

export default function SourcePanel({
  lookup,
  heading,
  playerTitle = heading,
  episode = null,
  episodeChoices = [],
  playback = {},
}) {
  const suggestedFile = lookup.session?.status === "ready" && episode
    ? findEpisodeFile(lookup.session.files, episode.season, episode.number)
    : null;
  const defaultMovieFile = lookup.session?.status === "ready" && !episode
    ? findLargestFile(lookup.session.files)
    : null;
  const selectedFile = lookup.session?.files?.find(
    (file) => file.id === (lookup.selectedFileId ?? suggestedFile?.id ?? defaultMovieFile?.id),
  );
  const unmatchedPack = episode && lookup.session?.status === "ready"
    && lookup.session.files.length > 1 && !suggestedFile && !lookup.selectedFileId;
  const discovery = lookup.session?.discovery;
  const noReachablePeers = lookup.session?.peers === 0
    && discovery?.noPeerSources?.length > 0;
  const episodeFiles = episode
    ? (lookup.session?.files || []).map((file) => ({
      file,
      display: episodeFilePresentation(file, episodeChoices),
    }))
    : [];

  return (
    <section className="sourcePanel" aria-labelledby="source-heading">
      <div className="sectionHeading sourceHeading">
        <div>
          <span className="eyebrow">Authorized sources</span>
          <h2 id="source-heading">{heading}</h2>
        </div>
        {lookup.session ? (
          <button className="textButton" type="button" onClick={lookup.stop}>
            Stop &amp; clean up
          </button>
        ) : null}
      </div>

      {lookup.errorCode === "NO_TORRENT_SOURCES" ? (
        <div className="notice" role="status">
          No torrent sources are configured. <Link href="/setup/sources">Choose sources →</Link>
        </div>
      ) : lookup.error ? <div className="notice error" role="alert">{lookup.error}</div> : null}
      {lookup.searching ? <div className="notice">Searching sources…</div> : null}
      {!lookup.searching && lookup.hasSearched && lookup.results.length === 0 && !lookup.error ? (
        <div className="notice">No usable authorized sources were found.</div>
      ) : null}

      {lookup.results.length > 0 && !lookup.session ? (
        <div className="sourceResults" aria-live="polite">
          {lookup.results.map((result) => (
            <article className="sourceResult" key={result.id}>
              <div>
                <h3>{result.title}</h3>
                <div className="metadata">
                  <span>{result.indexer}</span>
                  <span>{formatFileSize(result.size)}</span>
                  <span>{result.seeders.toLocaleString()} seeders</span>
                  <span className={result.verification === "verified" ? "available" : "muted"}>
                    {result.verification === "verified" ? "Streamable" : "Magnet · verify on start"}
                  </span>
                  <span className={result.hasMagnet ? "available" : "muted"}>
                    Magnet: {result.hasMagnet ? "Yes" : "No"}
                  </span>
                </div>
              </div>
              <button
                className="primaryButton compact"
                type="button"
                disabled={!result.canStart || lookup.startingId !== null}
                onClick={() => lookup.start(result.id)}
              >
                {lookup.startingId === result.id
                  ? "Starting…"
                  : result.verification === "verified" ? "Use source" : "Verify & use"}
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {lookup.session?.status === "loading" ? (
        <div className="notice">
          Connecting to peers and loading torrent metadata… {lookup.session.peers ?? 0} peers connected
          {discovery ? ` · ${discovery.trackerCount} trackers · DHT ${discovery.dhtAnnounced ? "active" : "starting"}` : ""}.
        </div>
      ) : null}
      {noReachablePeers ? (
        <div className="notice">
          No reachable peers have responded through trackers or DHT yet. The source&apos;s seeder count may be stale.
        </div>
      ) : null}
      {lookup.session?.status === "error" ? (
        <div className="notice error" role="alert">
          {lookup.session.error || "The torrent failed."}
        </div>
      ) : null}
      {lookup.session?.status === "ready" && lookup.session.files.length === 0 ? (
        <div className="notice">This source has no recognized video files.</div>
      ) : null}
      {unmatchedPack ? (
        <div className="notice">No exact SxxExx filename matched. Choose the episode file manually.</div>
      ) : null}

      {lookup.session?.files?.length > 0 ? (
        <div className="playbackWorkspace">
          <div className="videoFrame">
            {selectedFile ? (
              <div className="playerStack">
                <VideoPlayer
                  key={[
                    lookup.session.id,
                    selectedFile.id,
                    playback.profileId || "guest",
                    playback.media?.mediaType || "media",
                    playback.media?.tmdbId || "unknown",
                    playback.media?.seasonNumber ?? -1,
                    playback.media?.episodeNumber ?? -1,
                  ].join("-")}
                  sessionId={lookup.session.id}
                  file={selectedFile}
                  title={playerTitle}
                  {...playback}
                />
                <div className="bufferStatus" aria-live="polite">
                  <div>
                    <span>Downloaded {formatFileSize(selectedFile.downloaded)} of {formatFileSize(selectedFile.size)}</span>
                    <span>{formatSpeed(lookup.session.downloadSpeed)} · {lookup.session.peers ?? 0} peers</span>
                  </div>
                  <progress value={selectedFile.progress} max={1}>
                    {Math.round(selectedFile.progress * 100)}%
                  </progress>
                </div>
              </div>
            ) : (
              <div className="videoPlaceholder">Choose a video file to begin.</div>
            )}
          </div>
          {episode && episodeFiles.length > 1 ? (
            <div className="episodeFileList" aria-label="Episodes in this source">
              {episodeFiles.map(({ file, display }) => {
                const active = selectedFile?.id === file.id;
                const primary = `${display.code ? `${display.code} · ` : ""}${display.title}`;
                return (
                  <button
                    className={active ? "episodeFileChoice active" : "episodeFileChoice"}
                    type="button"
                    key={file.id}
                    title={display.fullPath}
                    aria-current={active ? "true" : undefined}
                    aria-label={`${primary}. ${display.technical.join(", ")}. ${display.filename}`}
                    onClick={() => lookup.setSelectedFileId(file.id)}
                  >
                    <span className="episodeFileHeading">
                      <strong>{primary}</strong>
                      {active ? <span className="playingBadge">Playing</span> : null}
                    </span>
                    <small>{display.technical.join(" · ")}</small>
                    <span className="episodeFilename">{display.filename}</span>
                  </button>
                );
              })}
            </div>
          ) : !episode && lookup.session.files.length > 1 ? (
            <div className="fileList" aria-label="Video files">
              {lookup.session.files.map((file) => (
                <button
                  className={selectedFile?.id === file.id ? "file active" : "file"}
                  type="button"
                  key={file.id}
                  onClick={() => lookup.setSelectedFileId(file.id)}
                >
                  <span>{file.name}</span>
                  <small>
                    {file.relativePath && file.relativePath !== file.name
                      ? `${file.relativePath} · ${formatFileSize(file.size)}`
                      : formatFileSize(file.size)}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
