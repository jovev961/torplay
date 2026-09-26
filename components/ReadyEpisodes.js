import { readyEpisodesForSeason } from "../lib/video/ready-episodes.js";

function episodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function shouldShowReadyEpisodes({ session, hasPlayerFile, launchedEpisodeKey,
  selectedEpisodeKey }) {
  return session?.backend === "debrid" && hasPlayerFile
    && launchedEpisodeKey === selectedEpisodeKey;
}

export default function ReadyEpisodes({ seasonNumber, seasonName, seasonEpisodes = [], episodes = [],
  playing = null, loading = false, unavailable = false, disabled = false, onPlay = () => {} }) {
  const ready = readyEpisodesForSeason(episodes, seasonNumber);
  return (
    <section className="seasonSection readyEpisodeSection" aria-labelledby="ready-episodes-heading">
      <div className="sectionHeading">
        <div>
          <span className="eyebrow">Connected providers</span>
          <h2 id="ready-episodes-heading">Ready episodes · {seasonName || `Season ${seasonNumber}`}</h2>
        </div>
      </div>
      {loading ? <div className="notice">Checking known ready episodes…</div> : null}
      {!loading && unavailable ? (
        <div className="notice" role="status">Some provider episodes are temporarily unavailable.</div>
      ) : null}
      {!loading && !unavailable && ready.length === 0 ? (
        <div className="notice">No ready episodes for this season.</div>
      ) : null}
      {!loading && ready.length > 0 ? (
        <div className="episodeFileList" aria-label={`Ready episodes in Season ${seasonNumber}`}>
          {ready.map((entry) => {
            const title = seasonEpisodes.find((item) => item.number === entry.episode)?.title
              || `Episode ${entry.episode}`;
            const active = playing?.season === entry.season && playing?.episode === entry.episode;
            return (
              <button className={active ? "episodeFileChoice active" : "episodeFileChoice"}
                type="button" key={`${entry.season}:${entry.episode}`}
                aria-current={active ? "true" : undefined} disabled={disabled}
                onClick={() => onPlay(entry.episode)}>
                <span className="episodeFileHeading">
                  <strong>{episodeCode(entry.season, entry.episode)} · {title}</strong>
                  {active ? <span className="playingBadge">Playing</span> : null}
                </span>
                <small>Ready through {entry.provider === "torbox" ? "TorBox" : "Real-Debrid"}</small>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
