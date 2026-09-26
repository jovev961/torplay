"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { findEpisodeFile, findLargestFile } from "../lib/video/episode.js";
import { episodeFileCardModel, episodeFilePresentation, formatFileSize } from "../lib/video/episode-display.js";
import { inferMediaBadges } from "../lib/video/media-capabilities.js";
import VideoPlayer from "./VideoPlayer.js";
import { useOptionalI18n } from "./I18nProvider.js";

function formatSpeed(value) {
  return Number.isFinite(value) && value > 0 ? `${formatFileSize(value)}/s` : "0 B/s";
}

function providerName(id) {
  return id === "torbox" ? "TorBox" : "Real-Debrid";
}

function formatCacheAge(createdAt, t) {
  const elapsed = Math.max(0, Date.now() - Number(createdAt || 0));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{count} min ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{count} hr ago", { count: hours });
  return t("{count} days ago", { count: Math.floor(hours / 24) });
}

export default function SourcePanel({
  lookup,
  heading,
  playerTitle = heading,
  episode = null,
  episodeChoices = [],
  playback = {},
  onSourceReset = null,
  transitionPending = false,
  pendingEpisodeTitle = null,
}) {
  const i18n = useOptionalI18n();
  const t = i18n?.t || ((message, values = {}) => message.replace(/\{(\w+)\}/g,
    (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match));
  const [downloadFileIds, setDownloadFileIds] = useState(null);
  const [requestedDownloadFileId, setRequestedDownloadFileId] = useState(null);
  const [expandedFileId, setExpandedFileId] = useState(null);
  const [lastPlayback, setLastPlayback] = useState(null);
  const choiceRef = useRef(null);
  useEffect(() => {
    if (lookup.debridChoice?.resultId) choiceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [lookup.debridChoice?.resultId]);
  const reviewId = lookup.debridJob?.resourceId;
  const selectedDownloadIds = downloadFileIds && downloadFileIds.resourceId === reviewId
    ? downloadFileIds.ids : null;
  const selectedRequestedFileId = requestedDownloadFileId && requestedDownloadFileId.resourceId === reviewId
    ? requestedDownloadFileId.id : null;
  const suggestedFile = lookup.session?.status === "ready" && episode
    ? lookup.session.files.find((file) => file.id === lookup.session.suggestedFileId)
      || findEpisodeFile(lookup.session.files, episode.season, episode.number)
    : null;
  const defaultMovieFile = lookup.session?.status === "ready" && !episode
    ? findLargestFile(lookup.session.files)
    : null;
  const selectedFile = lookup.session?.files?.find(
    (file) => file.id === (lookup.selectedFileId ?? suggestedFile?.id ?? defaultMovieFile?.id),
  );
  useEffect(() => {
    if (transitionPending || !selectedFile || !lookup.session) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLastPlayback({ session: lookup.session, file: selectedFile, title: playerTitle, playback });
    });
    return () => { cancelled = true; };
  }, [lookup.session, playback, playerTitle, selectedFile, transitionPending]);
  const playerSource = transitionPending ? lastPlayback : selectedFile && lookup.session
    ? { session: lookup.session, file: selectedFile, title: playerTitle, playback }
    : null;
  const displaySession = playerSource?.session;
  const displayFile = playerSource?.file;
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
          <div className="sourceHeadingActions">
            <button className="secondaryButton" type="button" onClick={() => void (async () => {
              await onSourceReset?.();
              await lookup.changeSource();
            })()}>
              Change source
            </button>
            <button className="sourceStopButton" type="button" onClick={() => void (async () => {
              await onSourceReset?.();
              await lookup.stop();
            })()}>
              {lookup.session.backend === "debrid" ? "Stop playback" : "Stop & clean up"}
            </button>
          </div>
        ) : null}
      </div>

      {lookup.errorCode === "NO_TORRENT_SOURCES" ? (
        <div className="notice" role="status">
          No torrent sources are configured. <Link href="/setup/sources">Choose sources →</Link>
        </div>
      ) : lookup.error ? <div className="notice error" role="alert">{lookup.error}</div> : null}
      {transitionPending ? <div className="notice" role="status">
        {pendingEpisodeTitle ? `Choose a source for ${pendingEpisodeTitle}.` : "Choose a source for this episode."}
        {" "}The player will stay open while you choose.
      </div> : null}
      {lookup.searching ? <div className="notice">Searching sources…</div> : null}
      {!lookup.session && lookup.readySources?.length > 0 ? (
        <div className="readySourceResults" aria-label="Ready Debrid sources">
          <div><span className="eyebrow">Ready to watch</span><p>Choose a ready provider source, or pick a torrent below.</p></div>
          {lookup.readySources.map((source) => {
            const name = source.name || playerTitle;
            const badges = inferMediaBadges(name);
            return <article className="readySource" key={`${source.provider}:${source.resourceId}`}>
              <div><strong>{name}</strong><span>Ready on {providerName(source.provider)}</span>
                {badges.length ? <div className="mediaCapabilityBadges compact" aria-label="Inferred media formats">
                  {badges.map((badge) => <span key={badge.id}>{badge.label}</span>)}
                </div> : null}
              </div>
              <button className="primaryButton compact" type="button" disabled={lookup.startingId !== null}
                onClick={() => void lookup.startReadySource(source)}>
                {lookup.startingId === `library:${source.provider}:${source.resourceId}` ? "Opening…" : `Watch with ${providerName(source.provider)}`}
              </button>
            </article>;
          })}
        </div>
      ) : null}
      {!lookup.session && lookup.readyUnavailable ? <div className="notice" role="status">
        A Debrid provider could not be checked right now. Torrent choices are still available.
      </div> : null}
      {lookup.debridChoice && !lookup.session && (!lookup.debridJob || lookup.debridJob.status === "failed") ? (
        <div className="debridChoice" role="group" aria-label="Choose how to watch" ref={choiceRef}>
          <div className="debridChoiceIntro">
            <span className="eyebrow">Choose how to watch</span>
            <h3>{lookup.results.find((result) => result.id === lookup.debridChoice.resultId)?.title || "Selected torrent"}</h3>
            <p>Pick a ready provider, prepare this torrent with a provider, or stream from torrent peers.</p>
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
                  <h4>{providerName(provider)}</h4>
                  <p className={lookup.debridChoice.availability?.[provider] === "ready" ? "sourceReady" : ""}>
                    {lookup.debridChoice.availability?.[provider] === "ready" ? "Ready to watch this movie or episode."
                      : lookup.debridChoice.availability?.[provider] === "not-ready" ? "Not ready yet. Prepare it in your account."
                        : "Could not confirm readiness. You can ask this provider to prepare it."}
                  </p>
                </div>
                {lookup.debridChoice.availability?.[provider] !== "ready" && provider === "real-debrid" && lookup.debridChoice.seasonPack
                  ? <p className="debridChoiceHint">Review the pack&apos;s video files before Real-Debrid starts downloading them.</p> : null}
                {lookup.debridChoice.availability?.[provider] !== "ready" && provider === "torbox" && lookup.debridChoice.seasonPack
                  ? <p className="debridChoiceHint">TorBox downloads the pack as one resource. You can choose an episode file when it is ready.</p> : null}
                <button className={lookup.debridChoice.availability?.[provider] === "ready" ? "primaryButton compact" : "debridChoiceSecondary"}
                  type="button" disabled={lookup.startingId !== null}
                  onClick={() => {
                    const ready = lookup.debridChoice.availability?.[provider] === "ready";
                    if (!ready && provider === "torbox" && lookup.debridChoice.seasonPack
                      && !window.confirm("TorBox may download this entire pack. Continue?")) return;
                    lookup.start(lookup.debridChoice.resultId, ready ? "ready" : "remote", provider,
                      provider === "real-debrid" && lookup.debridChoice.seasonPack ? "all" : "episode",
                      provider === "torbox" && lookup.debridChoice.seasonPack);
                  }}>
                  {lookup.debridChoice.availability?.[provider] === "ready"
                    ? `Watch with ${providerName(provider)}` : `Prepare with ${providerName(provider)}`}
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
          {lookup.debridJob.status === "awaiting-selection" ? <div className="debridFileReview">
            <strong>Choose video files for Real-Debrid</strong>
            <p>Video files are preselected. Review the list, identify the requested episode, then confirm. Real-Debrid starts downloading after confirmation.</p>
            {lookup.debridJob.files.filter((file) => lookup.debridJob.suggestedSelectionIds.includes(file.providerId))
              .map((file) => {
                const checked = (selectedDownloadIds || lookup.debridJob.suggestedSelectionIds).includes(file.providerId);
                return <div className="debridFileReviewRow" key={file.providerId}>
                  <label><input type="checkbox" checked={checked} onChange={() => setDownloadFileIds(() => {
                    const ids = selectedDownloadIds || lookup.debridJob.suggestedSelectionIds;
                    return { resourceId: reviewId, ids: checked
                      ? ids.filter((id) => id !== file.providerId) : [...ids, file.providerId] };
                  })} /> {file.path} · {formatFileSize(file.size)}</label>
                  <label><input type="radio" name="requested-debrid-episode" checked={selectedRequestedFileId === file.providerId}
                    onChange={() => setRequestedDownloadFileId({ resourceId: reviewId, id: file.providerId })} /> Requested episode</label>
                </div>;
              })}
            <button className="primaryButton compact" type="button"
              disabled={!selectedRequestedFileId || !(selectedDownloadIds || lookup.debridJob.suggestedSelectionIds).includes(selectedRequestedFileId)}
              onClick={() => void lookup.confirmDebridFiles(selectedDownloadIds || lookup.debridJob.suggestedSelectionIds,
                selectedRequestedFileId)}>Confirm and download</button>
          </div> : null}
          {lookup.debridJob.status === "ready" && !lookup.debridJob.selectedFileId
            && lookup.debridJob.mediaContext?.type === "show" ? <div className="debridFileReview">
              <strong>Choose the requested episode file</strong>
              {lookup.debridJob.files.map((file) => <div className="debridFileReviewRow" key={file.providerId}>
                <span>{file.path} · {formatFileSize(file.size)}{file.selected ? "" : " · Not downloaded by Real-Debrid"}</span>
                <button type="button" onClick={() => void lookup.mapDebridFile(file.providerId)}>Use for this episode</button>
              </div>)}
            </div> : null}
          {lookup.debridChoice?.localAllowed ? <button type="button" onClick={() => lookup.start(lookup.debridChoice.resultId, "local")}>Watch Now with TorPlay instead</button> : null}
        </div>
      ) : null}
      {!lookup.session && !lookup.searching && !lookup.readyLoading && lookup.hasSearched && lookup.results.length === 0
        && !lookup.usenetResults?.length && !lookup.readySources?.length && !lookup.error ? (
        <div className="notice">No usable authorized sources were found.</div>
      ) : null}

      {lookup.results.length > 0 && !lookup.session ? (
        <div className="sourceResults" aria-live="polite">
          <div className="sourceResultsHeading">
            <div>
              <h3>{t("Torrents")}</h3>
              {lookup.cacheInfo ? <p className="sourceCacheStatus">
                {t(lookup.cacheInfo.status === "all"
                  ? "Cached results · updated {age}" : "Includes cached results · oldest updated {age}", {
                  age: formatCacheAge(lookup.cacheInfo.oldestCreatedAt, t),
                })}
              </p> : null}
            </div>
            <button className="secondaryButton compact" type="button"
              disabled={lookup.refreshing || lookup.startingId !== null}
              onClick={() => void lookup.refreshSearch()}>
              {t(lookup.refreshing ? "Refreshing…" : "Refresh torrents")}
            </button>
          </div>
          {lookup.refreshError ? <div className="notice error" role="alert">
            {t("Could not refresh torrents. Showing the previous results.")} {lookup.refreshError}
          </div> : null}
          {lookup.results.map((result) => (
            <article className={lookup.debridChoice?.resultId === result.id ? "sourceResult selected" : "sourceResult"} key={result.id}>
              <div>
                <h3>{result.title}</h3>
                <div className="metadata">
                  <span>{result.indexer}</span>
                  <span>{formatFileSize(result.size)}</span>
                  <span>{result.seeders.toLocaleString()} seeders</span>
                  <span className={result.verification === "verified" ? "available" : "muted"}>
                    {result.verification === "verified" ? "Streamable"
                      : result.verification === "checking" ? "Checking torrent…" : "Magnet · verify on start"}
                  </span>
                  <span className={result.hasMagnet ? "available" : "muted"}>
                    Magnet: {result.hasMagnet ? "Yes" : "No"}
                  </span>
                </div>
                {result.mediaBadges?.length ? <div className="mediaCapabilityBadges" aria-label="Inferred media formats">
                  {result.mediaBadges.map((badge) => <span key={badge.id}>{badge.label}</span>)}
                </div> : null}
                <div className="sourceAvailability">
                  {Object.entries(lookup.torrentAvailability?.[result.id]?.availability || {}).map(([provider, status]) => (
                    <span className={status === "ready" ? "sourceReady" : status === "not-ready" ? "sourceNotReady" : "sourceUnknown"}
                      key={provider}>{providerName(provider)}: {status === "ready" ? "Ready" : status === "not-ready" ? "Not ready" : "Could not check"}</span>
                  ))}
                  {lookup.availabilityChecking && !lookup.torrentAvailability?.[result.id]
                    ? <span className="sourceUnknown">Checking Debrid…</span> : null}
                </div>
              </div>
              <button
                className="primaryButton compact"
                type="button"
                disabled={!result.canStart || result.verification === "checking" || lookup.startingId !== null}
                onClick={() => lookup.selectResult(result.id)}
              >
                {lookup.startingId === result.id
                  ? "Checking torrent…" : "Choose torrent"}
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
        <div className="notice">{lookup.session.backend === "debrid"
          ? <>No exact episode mapping was found. Map the file in <Link href="/debrid-library">Debrid Library</Link>.</>
          : "No exact SxxExx filename matched. Choose the episode file manually."}</div>
      ) : null}

      {displayFile || lookup.session?.files?.length > 0 ? (
        <div className="playbackWorkspace">
          <div className="videoFrame">
            {displayFile ? (
              <div className="playerStack">
                <VideoPlayer
                  sessionId={displaySession.id}
                  file={displayFile}
                  title={playerSource.title}
                  {...playerSource.playback}
                  suspended={transitionPending}
                  sourcePicker={transitionPending ? <div className="playerSourcePickerContent">
                    <strong>{pendingEpisodeTitle || "Choose a source"}</strong>
                    <p>Choose a ready source or torrent to continue in this player.</p>
                    {lookup.searching || lookup.readyLoading ? <p>Searching sources…</p> : null}
                    {lookup.readySources?.map((source) => <button type="button" key={`${source.provider}:${source.resourceId}`}
                      disabled={lookup.startingId !== null}
                      onClick={() => void lookup.startReadySource(source)}>
                      Watch with {providerName(source.provider)} · {source.name || "Ready episode"}
                    </button>)}
                    {lookup.results?.map((result) => <button type="button" key={result.id}
                      disabled={!result.canStart || lookup.startingId !== null}
                      onClick={() => void lookup.selectResult(result.id)}>
                      Choose torrent · {result.title}
                    </button>)}
                    {lookup.debridChoice ? <div className="playerSourcePickerOptions">
                      <strong>{lookup.results.find((result) => result.id === lookup.debridChoice.resultId)?.title || "Selected torrent"}</strong>
                      {lookup.debridChoice.localAllowed ? <button type="button"
                        disabled={lookup.startingId !== null}
                        onClick={() => void lookup.start(lookup.debridChoice.resultId, "local")}>Watch now with TorPlay</button> : null}
                      {lookup.debridChoice.providers.map((provider) => {
                        const ready = lookup.debridChoice.availability?.[provider] === "ready";
                        return <button type="button" key={provider} disabled={lookup.startingId !== null}
                          onClick={() => {
                            if (!ready && provider === "torbox" && lookup.debridChoice.seasonPack
                              && !window.confirm("TorBox may download this entire pack. Continue?")) return;
                            void lookup.start(lookup.debridChoice.resultId,
                              ready ? "ready" : "remote", provider,
                              provider === "real-debrid" && lookup.debridChoice.seasonPack ? "all" : "episode",
                              provider === "torbox" && lookup.debridChoice.seasonPack);
                          }}>
                          {ready ? "Watch with" : "Prepare with"} {providerName(provider)}
                        </button>;
                      })}
                    </div> : null}
                    {lookup.debridJob ? <p>{lookup.debridJob.provider === "torbox" ? "TorBox" : "Real-Debrid"}
                      {" "}preparation: {lookup.debridJob.status}</p> : null}
                    {lookup.error ? <p role="alert">{lookup.error}</p> : null}
                  </div> : null}
                />
                {displaySession.backend === "debrid" ? (
                  <div className="bufferStatus" aria-live="polite">
                    Ready through {displaySession.sourceType === "usenet" ? "TorBox Usenet"
                      : displaySession.provider === "torbox" ? "TorBox" : "Real-Debrid"}
                  </div>
                ) : <div className="bufferStatus" aria-live="polite">
                  <div>
                    <span>Downloaded {formatFileSize(displayFile.downloaded)} of {formatFileSize(displayFile.size)}</span>
                    <span>{formatSpeed(displaySession.downloadSpeed)} · {displaySession.peers ?? 0} peers</span>
                  </div>
                  <progress value={displayFile.progress} max={1}>
                    {Math.round(displayFile.progress * 100)}%
                  </progress>
                </div>}
              </div>
            ) : (
              <div className="videoPlaceholder">Choose a video file to begin.</div>
            )}
          </div>
          {!transitionPending && episode && lookup.session?.backend !== "debrid" && episodeFiles.length > 1 ? (
            <div className="torplayEpisodeBrowser">
              <div className="torplayEpisodeHeading">
                <div>
                  <span className="eyebrow">TorPlay</span>
                  <h3>Episodes in this source</h3>
                </div>
                <span>{episodeFiles.length} episodes</span>
              </div>
              <div className="episodeFileList torplayEpisodeList" aria-label="TorPlay episodes in this source">
                {episodeFiles.map(({ file, display }) => {
                  const active = selectedFile?.id === file.id;
                  const { primary, expandable } = episodeFileCardModel(display);
                  const expansionKey = `${lookup.session.id}:${file.id}`;
                  const expanded = expandedFileId === expansionKey;
                  return (
                    <div
                      className={active ? "episodeFileChoice active" : "episodeFileChoice"}
                      key={file.id}
                    >
                      <button className="episodeFileSelect" type="button"
                        aria-current={active ? "true" : undefined}
                        aria-label={`${primary}. ${display.technical.join(", ")}. Select file`}
                        onClick={() => void (lookup.selectEpisodeFile || lookup.setSelectedFileId)(file.id)}>
                        <span className="episodeFileHeading">
                          <strong className={!display.recognized ? "unidentifiedFileName" : ""}>{primary}</strong>
                          {active ? <span className="playingBadge">Playing</span> : null}
                        </span>
                        <small>{display.technical.join(" · ")}</small>
                        {display.mediaBadges.length ? <span className="mediaCapabilityBadges compact" aria-label="Inferred media formats">
                          {display.mediaBadges.map((badge) => <span key={badge.id}>{badge.label}</span>)}
                        </span> : null}
                        {display.recognized ? <span className="episodeFilename">{display.filename}</span>
                          : <span className="episodeFilename">Unidentified episode</span>}
                      </button>
                      {expandable ? <button className="episodeFileExpand" type="button"
                        aria-expanded={expanded} onClick={() => setExpandedFileId(expanded ? null : expansionKey)}>
                        {expanded ? "Hide full name" : "Show full name"}
                      </button> : null}
                      {expanded ? <div className="episodeFileFullName">{display.fullPath}</div> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : !transitionPending && !episode && lookup.session?.files.length > 1 ? (
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
