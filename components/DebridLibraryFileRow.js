import { formatFileSize } from "../lib/video/episode-display.js";

export default function DebridLibraryFileRow({ file, mappings, isShow, ready, playing, editing,
  mapSeason, mapEpisode, mappingBusy, mappingError, onEdit, onCancel, onMap, onPlay,
  onSeasonChange, onEpisodeChange }) {
  return <div className={`debridLibraryFile${playing ? " isPlaying" : ""}`}>
    <div className="debridLibraryFileMain">
      <strong title={file.name}>{file.name}</strong>
      <span className="debridLibraryFileSize">{formatFileSize(file.size)}</span>
      {playing ? <span className="debridLibraryFilePlaying">Playing</span> : null}
      {isShow ? <div className="debridLibraryMappingStatus">
        {mappings.length ? mappings.map((entry) => <span className="debridLibraryMapped" key={`${entry.season}:${entry.episode}`}>
          Mapped to S{String(entry.season).padStart(2, "0")}E{String(entry.episode).padStart(2, "0")}
        </span>) : <><span className="debridLibraryUnmapped">Not mapped</span>
          <span className="debridLibraryMappingHint">Choose an episode to enable direct playback from the show page.</span></>}
      </div> : null}
    </div>
    <div className="debridLibraryFileActions">
      {isShow ? <button type="button" className="debridLibraryMapButton" aria-expanded={editing}
        onClick={editing ? onCancel : onEdit}>{mappings.length ? "Change mapping" : "Map episode"}</button> : null}
      {ready && file.selected ? <button className="primaryButton compact" type="button"
        onClick={onPlay}>{playing ? "Play again" : "Play"}</button> : null}
    </div>
    {editing ? <div className="debridLibraryMapEditor">
      <p>{mappings.length ? "Choose the correct episode. Saving replaces this file’s current episode assignments."
        : "Which episode is in this file?"}</p>
      <div className="debridLibraryMapFields">
        <label>Season <input type="number" min="0" max="99" value={mapSeason}
          onChange={(event) => onSeasonChange(Number(event.target.value))} /></label>
        <label>Episode <input type="number" min="1" max="999" value={mapEpisode}
          onChange={(event) => onEpisodeChange(Number(event.target.value))} /></label>
        <button className="primaryButton compact" type="button" disabled={mappingBusy
          || !Number.isInteger(mapSeason) || mapSeason < 0 || mapSeason > 99
          || !Number.isInteger(mapEpisode) || mapEpisode < 1 || mapEpisode > 999}
          onClick={onMap}>{mappingBusy ? "Saving…" : "Save mapping"}</button>
        <button type="button" disabled={mappingBusy} onClick={onCancel}>Cancel</button>
      </div>
      {mappingError ? <p className="debridLibraryMapError" role="alert">{mappingError}</p> : null}
    </div> : null}
  </div>;
}
