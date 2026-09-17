"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { catalogHref } from "../lib/metadata/catalog.js";

function supportLabel(genre) {
  if (genre.supportedMediaTypes.length === 2) return genre.name;
  return `${genre.name} (${genre.supportedMediaTypes[0] === "movie" ? "Movies" : "TV"})`;
}

export default function CatalogFilters({ pathname, initialQuery = "", initialType = "all", initialGenre = "", genres }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState(initialType);
  const [genre, setGenre] = useState(initialGenre);

  function submit(event) {
    event.preventDefault();
    router.push(catalogHref(pathname, { query, type, genre }));
  }

  return (
    <form className="catalogFilters" onSubmit={submit}>
      {pathname === "/search" ? (
        <label className="queryField">
          <span>Title</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search movies and TV shows…"
            maxLength={200}
          />
        </label>
      ) : null}
      <label>
        <span>Media type</span>
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="all">All</option>
          <option value="movie">Movies</option>
          <option value="tv">TV Shows</option>
        </select>
      </label>
      <label>
        <span>Genre</span>
        <select value={genre} onChange={(event) => setGenre(event.target.value)}>
          <option value="">All Genres</option>
          {genres.map((item) => (
            <option value={item.slug} key={item.slug}>{supportLabel(item)}</option>
          ))}
        </select>
      </label>
      <button type="submit">{pathname === "/search" ? "Search" : "Apply filters"}</button>
    </form>
  );
}
