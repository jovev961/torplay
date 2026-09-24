export function readyEpisodesForSeason(episodes, season) {
  const number = Number(season);
  return (Array.isArray(episodes) ? episodes : [])
    .filter((entry) => Number.isSafeInteger(entry?.season) && entry.season === number
      && Number.isSafeInteger(entry?.episode) && entry.episode > 0)
    .sort((a, b) => a.episode - b.episode);
}
