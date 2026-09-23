function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function definitionPath(value) {
  if (typeof value !== "string") return "";
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    return normalized(path.match(/\/definitions\/v11\/(.+\.ya?ml)$/i)?.[1]);
  } catch {
    return "";
  }
}

export function unexploredCommunityEntries(entries, providers) {
  const cardigann = providers.filter((provider) => provider.kind === "cardigann");
  const ids = new Set(cardigann.map((provider) => normalized(provider.definitionId)).filter(Boolean));
  const paths = new Set(cardigann.map((provider) => definitionPath(provider.definitionUrl)).filter(Boolean));
  return entries.filter((entry) => !ids.has(normalized(entry.definitionId)) && !paths.has(normalized(entry.id)));
}

export function filterCommunityEntries(entries, { query = "", media = "all", access = "all" } = {}) {
  const search = normalized(query);
  return entries.filter((entry) => (
    (!search || `${entry.name} ${entry.id}`.toLowerCase().includes(search))
    && (media === "all" || (media === "Anime" ? entry.anime : entry.mediaTypes.includes(media)))
    && (access === "all" || entry.access === access)
  ));
}
