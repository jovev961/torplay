export function interleaveByRank(...lists) {
  const results = [];
  const maximumLength = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < maximumLength; index += 1) {
    for (const list of lists) {
      if (list[index]) results.push(list[index]);
    }
  }
  return results;
}

export function mediaDetailsHref(item) {
  return item.mediaType === "movie" ? `/movies/${item.id}` : `/shows/${item.id}`;
}

export function catalogHref(pathname, { query = "", type = "all", genre = "", page = 1 } = {}) {
  const params = new URLSearchParams();
  if (pathname === "/search" && query.trim()) params.set("q", query.trim());
  if (type !== "all") params.set("type", type);
  if (genre) params.set("genre", genre);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}
