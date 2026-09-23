"use client";

import Link from "next/link";
import { useState } from "react";
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
  const [packScope, setPackScope] = useState("episode");
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
            {lookup.session.backend === "debrid" ? "Stop playback" : "Stop & clean up"}
          </button>
        ) : null}
      </div>

      {lookup.errorCode === "NO_TORRENT_SOURCES" ? (
        <div className="notice" role="status">
          No torrent sources are configured. <Link href="/setup/sources">Choose sources →</Link>
        </div>
      ) : lookup.error ? <div className="notice error" role="alert">{lookup.error}</div> : null}
      {lookup.searching ? <div className="notice">Searching sources…</div> : null}
      {lookup.debridChoice && !lookup.session && (!lookup.debridJob || lookup.debridJob.status === "failed") ? (
        <div className="debridChoice" role="group" aria-label="Choose how to watch">
          <div className="debridChoiceIntro">
            <span className="eyebrow">Choose how to watch</span>
            <h3>This release is not ready on your debrid services.</h3>
            <p>Watch from torrent peers now, or let a connected provider prepare it for later.</p>
          </div>
          {lookup.debridChoice.error ? <p className="debridChoiceError" role="alert">{lookup.debridChoice.error}</p> : null}
          {!lookup.debridChoice.localAllowed && !lookup.debridChoice.providers.length
            ? <p>No connected provider can prepare this torrent right now. Check Settings → Services.</p> : null}
          <div className="debridChoiceOptions">
            {lookup.debridChoice.localAllowed ? <div className="debridChoiceOption">
              <div><h4>Watch now with TorPlay</h4><p>Stream directly from torrent peers.</p></div>
              <button className="primaryButton" type="button" disabled={lookup.startingId !== null}
                onClick={() => lookup.start(lookup.debridChoice.resultId, "local")}>▶ Watch now</button>
            </div> : null}
            {lookup.debridChoice.providers.map((provider) => (
              <div className="debridChoiceOption" key={provider}>
                <div>
                  <h4>Download with {provider === "torbox" ? "TorBox" : "Real-Debrid"}</h4>
                  <p>Prepare this release in your provider account. You can leave this page while it downloads.</p>
                </div>
                {provider === "real-debrid" && lookup.debridChoice.seasonPack ? (
                  <label className="debridChoiceScope">What to download
                    <select value={packScope} onChange={(event) => setPackScope(event.target.value)}>
                      <option value="episode">Only the current episode</option>
                      <option value="all">All identified episodes</option>
                    </select>
                  </label>
                ) : null}
                {provider === "torbox" && lookup.debridChoice.seasonPack
                  ? <p className="debridChoiceHint">TorBox may download the whole pack. Playback will select this episode.</p> : null}
                <button className="debridChoiceSecondary" type="button" disabled={lookup.startingId !== null}
                  onClick={() => lookup.start(lookup.debridChoice.resultId, "remote", provider,
                    provider === "real-debrid" ? packScope : "episode")}>
                  Download with {provider === "torbox" ? "TorBox" : "Real-Debrid"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {lookup.debridJob && !lookup.session ? (
        <div className="notice" role="status">
          <strong>{lookup.debridJob.name}</strong> · {lookup.debridJob.provider === "torbox" ? "TorBox" : "Real-Debrid"}
          <p>Remote download: {lookup.debridJob.status}
            {lookup.debridJob.progress != null ? ` · ${Math.round(lookup.debridJob.progress * 100)}%` : ""}
          </p>
          <p>You can leave this page. The provider job remains in <Link href="/debrid-library">Debrid Library</Link>.</p>
          {lookup.debridChoice?.localAllowed ? <button type="button" onClick={() => lookup.start(lookup.debridChoice.resultId, "local")}>Watch Now with TorPlay instead</button> : null}
        </div>
      ) : null}
      {!lookup.searching && lookup.hasSearched && lookup.results.length === 0 && !lookup.usenetResults?.length && !lookup.error ? (
        <div className="notice">No usable authorized sources were found.</div>
      ) : null}

      {lookup.results.length > 0 && !lookup.session ? (
        <div className="sourceResults" aria-live="polite">
          <h3>Torrents</h3>
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
                  ? "Resolving playback…"
                  : result.verification === "verified" ? "Use source" : "Verify & use"}
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {!lookup.session && (lookup.usenetEnabled || lookup.usenetJobs?.length > 0) ? (
        <div className="sourceResults" aria-live="polite">
          <h3>Usenet</h3>
          {lookup.usenetEnabled ? <label>
            Upload NZB
            <input type="file" accept=".nzb,application/x-nzb,application/xml"
              disabled={lookup.startingId !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void lookup.uploadNzb(file);
                event.target.value = "";
              }} />
          </label> : null}
          {lookup.usenetResults?.map((result) => (
            <article className="sourceResult" key={result.id}>
              <div><h3>{result.title}</h3><div className="metadata">
                <span>NZB · {result.indexer}</span>
                {result.size ? <span>{formatFileSize(result.size)}</span> : null}
                {result.category ? <span>{result.category}</span> : null}
              </div></div>
              <button className="primaryButton compact" type="button"
                disabled={lookup.startingId !== null} onClick={() => lookup.startUsenet(result.id)}>
                {lookup.startingId === result.id ? "Submitting…" : "Prepare with TorBox"}
              </button>
            </article>
          ))}
          {lookup.usenetJobs?.map((job) => (
            <article className="sourceResult" key={job.id}>
              <div><h3>{job.title}</h3><span>TorBox Usenet job</span></div>
              <div>
                <button type="button" onClick={() => lookup.resumeUsenet(job.id)}>Resume</button>
                <button type="button" onClick={() => lookup.deleteUsenet(job.id)}>Delete job</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {!lookup.session && lookup.usenetJob ? (
        <div className="notice" role="status">
          Preparing Usenet media through TorBox: {lookup.usenetJob.status}
          {lookup.usenetJob.progress != null ? ` · ${Math.round(lookup.usenetJob.progress * 100)}%` : ""}
          {lookup.usenetJob.message ? ` · ${lookup.usenetJob.message}` : ""}
          {lookup.usenetJob.status === "timed-out"
            ? " · Preparation is taking too long. Resume later to check the job." : ""}
          <button type="button" onClick={() => lookup.deleteUsenet(lookup.usenetJob.id)}>
            {lookup.usenetJob.status === "ready" ? "Delete job" : "Cancel and delete job"}
          </button>
        </div>
      ) : null}

      {lookup.session?.status === "loading" ? (
        <div className="notice">
          Connecting to peers and loading torrent metadata… {lookup.session.peers ?? 0} peers connected
          {discovery ? ` · ${discovery.trackerCount} trackers · DHT ${discovery.dhtAnnounced ? "active" : "starting"}` : ""}.
        </div>
      ) : null}
      {lookup.session?.resolution?.length ? (
        <div className="notice" role="status">
          {lookup.session.resolution.map((step) => `${step.provider === "local" ? "Local BitTorrent" : step.provider === "torbox" ? "TorBox" : "Real-Debrid"}: ${step.status}`).join(" · ")}
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
                {lookup.session.backend === "debrid" ? (
                  <div className="bufferStatus" aria-live="polite">
                    Ready through {lookup.session.sourceType === "usenet" ? "TorBox Usenet"
                      : lookup.session.provider === "torbox" ? "TorBox" : "Real-Debrid"}
                  </div>
                ) : <div className="bufferStatus" aria-live="polite">
                  <div>
                    <span>Downloaded {formatFileSize(selectedFile.downloaded)} of {formatFileSize(selectedFile.size)}</span>
                    <span>{formatSpeed(lookup.session.downloadSpeed)} · {lookup.session.peers ?? 0} peers</span>
                  </div>
                  <progress value={selectedFile.progress} max={1}>
                    {Math.round(selectedFile.progress * 100)}%
                  </progress>
                </div>}
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
