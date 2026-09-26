"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { catalogHref } from "../lib/metadata/catalog.js";
import { useI18n } from "./I18nProvider.js";

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
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="all">{t("All")}</option>
          <option value="movie">{t("Movies")}</option>
          <option value="tv">{t("TV Shows")}</option>
        </select>
      </label>
      <label>
        <span>{t("Genre")}</span>
        <select value={genre} onChange={(event) => setGenre(event.target.value)}>
          <option value="">{t("All Genres")}</option>
          {genres.map((item) => (
            <option value={item.slug} key={item.slug}>{supportLabel(item, t)}</option>
          ))}
        </select>
      </label>
      <button type="submit">{t(pathname === "/search" ? "Search" : "Apply filters")}</button>
    </form>
  );
}
