"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { catalogHref } from "../lib/metadata/catalog.js";
import { useI18n } from "./I18nProvider.js";
import RemoteSelect from "./RemoteSelect.js";

function supportLabel(genre, t) {
  if (genre.supportedMediaTypes.length === 2) return genre.name;
  return `${genre.name} (${t(genre.supportedMediaTypes[0] === "movie" ? "Movies" : "TV")})`;
}

export default function CatalogFilters({ pathname, initialQuery = "", initialType = "all", initialGenre = "", mode = "", genres }) {
  const router = useRouter();
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState(initialType);
  const [genre, setGenre] = useState(initialGenre);

  function submit(event) {
    event.preventDefault();
    router.push(catalogHref(pathname, { query, type, genre, mode }));
  }

  return (
    <form className="catalogFilters" onSubmit={submit}>
      {pathname === "/search" ? (
        <label className="queryField">
          <span>{t("Title")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search movies and TV shows…")}
            maxLength={200}
          />
        </label>
      ) : null}
      <label>
        <span>{t("Media type")}</span>
        <RemoteSelect value={type} onChange={setType} ariaLabel={t("Media type")} options={[
          { value: "all", label: t("All") }, { value: "movie", label: t("Movies") },
          { value: "tv", label: t("TV Shows") },
        ]} />
      </label>
      <label>
        <span>{t("Genre")}</span>
        <RemoteSelect value={genre} onChange={setGenre} ariaLabel={t("Genre")} options={[
          { value: "", label: t("All Genres") },
          ...genres.map((item) => ({ value: item.slug, label: supportLabel(item, t) })),
        ]} />
      </label>
      <button type="submit">{t(pathname === "/search" ? "Search" : "Apply filters")}</button>
    </form>
  );
}
