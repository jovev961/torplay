import AppHeader from "../../components/AppHeader.js";
import CatalogFilters from "../../components/CatalogFilters.js";
import CatalogFooter from "../../components/CatalogFooter.js";
import CatalogResults from "../../components/CatalogResults.js";
import { catalogHref } from "../../lib/metadata/catalog.js";
import { getGenreDefinitions, searchCatalog } from "../../lib/metadata/tmdb.js";

export const dynamic = "force-dynamic";

function value(input, fallback = "") {
  return typeof input === "string" ? input : fallback;
}

export default async function SearchPage({ searchParams }) {
  const params = await searchParams;
  const query = value(params.q).trim();
  const type = ["movie", "tv"].includes(value(params.type)) ? params.type : "all";
  const genre = value(params.genre);
  const page = value(params.page, "1");

  const [genreState, resultState] = await Promise.all([
    getGenreDefinitions("all").then((genres) => ({ genres, error: "" })).catch((error) => ({ genres: [], error: error.message })),
    query
      ? searchCatalog({ query, type, genre, page }).then((result) => ({ result, error: "" })).catch((error) => ({ result: null, error: error.message }))
      : Promise.resolve({ result: null, error: "" }),
  ]);
  const selectedGenre = genreState.genres.find((item) => item.slug === genre);
  const typeLabel = type === "movie" ? "movies" : type === "tv" ? "TV shows" : "movies or TV shows";
  const emptyMessage = selectedGenre
    ? `No ${selectedGenre.name} ${typeLabel} matched “${query}” on this provider page.`
    : `No ${typeLabel} matched “${query}”.`;
  const currentHref = catalogHref("/search", { query, type, genre, page: Number(page) || 1 });

  return (
    <main className="shell homeShell">
      <AppHeader active="search" />
      <section className="catalogHero compactCatalogHero">
        <span className="eyebrow">Search the catalog</span>
        <h1>Find movies and TV shows together.</h1>
        <p>Search TMDB metadata first, then choose an authorized source from the title page.</p>
      </section>
      <CatalogFilters
        key={`${query}|${type}|${genre}`}
        pathname="/search"
        initialQuery={query}
        initialType={type}
        initialGenre={genre}
        genres={genreState.genres}
      />
      {genreState.error ? <div className="notice error">Genres are unavailable: {genreState.error}</div> : null}
      {!query ? <div className="notice">Enter a title to search movies and TV shows.</div> : null}
      {resultState.error ? (
        <div className="notice error" role="alert">
          {resultState.error} <a className="inlineLink" href={currentHref}>Retry</a>
        </div>
      ) : null}
      {resultState.result ? (
        <CatalogResults
          pathname="/search"
          result={resultState.result}
          state={{ query, type, genre }}
          emptyMessage={emptyMessage}
        />
      ) : null}
      <CatalogFooter />
    </main>
  );
}
