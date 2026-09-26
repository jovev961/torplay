import AppHeader from "../../components/AppHeader.js";
import CatalogFilters from "../../components/CatalogFilters.js";
import CatalogFooter from "../../components/CatalogFooter.js";
import CatalogResults from "../../components/CatalogResults.js";
import { catalogHref } from "../../lib/metadata/catalog.js";
import { getGenreDefinitions, searchCatalog } from "../../lib/metadata/tmdb.js";
import { requireSetupReady } from "../_lib/require-setup.js";
import { getServerI18n } from "../_lib/i18n.js";

export const dynamic = "force-dynamic";

function value(input, fallback = "") {
  return typeof input === "string" ? input : fallback;
}

export default async function SearchPage({ searchParams }) {
  await requireSetupReady();
  const { locale, t } = await getServerI18n();
  const params = await searchParams;
  const query = value(params.q).trim();
  const type = ["movie", "tv"].includes(value(params.type)) ? params.type : "all";
  const genre = value(params.genre);
  const page = value(params.page, "1");

  const [genreState, resultState] = await Promise.all([
    getGenreDefinitions("all", { locale }).then((genres) => ({ genres, error: "" })).catch((error) => ({ genres: [], error: error.message })),
    query
      ? searchCatalog({ query, type, genre, page, locale }).then((result) => ({ result, error: "" })).catch((error) => ({ result: null, error: error.message }))
      : Promise.resolve({ result: null, error: "" }),
  ]);
  const selectedGenre = genreState.genres.find((item) => item.slug === genre);
  const typeLabel = type === "movie" ? t("movies") : type === "tv" ? t("TV shows") : t("movies or TV shows");
  const emptyMessage = selectedGenre
    ? t("No {genre} {type} matched “{query}” on this provider page.", {
      genre: selectedGenre.name, type: typeLabel, query,
    })
    : t("No {type} matched “{query}”.", { type: typeLabel, query });
  const currentHref = catalogHref("/search", { query, type, genre, page: Number(page) || 1 });

  return (
    <main className="shell homeShell">
      <AppHeader active="search" />
      <section className="catalogHero compactCatalogHero">
        <span className="eyebrow">{t("Search the catalog")}</span>
        <h1>{t("Find movies and TV shows together.")}</h1>
        <p>{t("Search TMDB metadata first, then choose an authorized source from the title page.")}</p>
      </section>
      <CatalogFilters
        key={`${query}|${type}|${genre}`}
        pathname="/search"
        initialQuery={query}
        initialType={type}
        initialGenre={genre}
        genres={genreState.genres}
      />
      {genreState.error ? <div className="notice error">{t("Genres are unavailable:")} {genreState.error}</div> : null}
      {!query ? <div className="notice">{t("Enter a title to search movies and TV shows.")}</div> : null}
      {resultState.error ? (
        <div className="notice error" role="alert">
          {resultState.error} <a className="inlineLink" href={currentHref}>{t("Retry")}</a>
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
