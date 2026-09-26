import AppHeader from "../../components/AppHeader.js";
import CatalogFilters from "../../components/CatalogFilters.js";
import CatalogFooter from "../../components/CatalogFooter.js";
import CatalogResults from "../../components/CatalogResults.js";
import { catalogHref } from "../../lib/metadata/catalog.js";
import { discoverCatalog, getGenreDefinitions } from "../../lib/metadata/tmdb.js";
import { requireSetupReady } from "../_lib/require-setup.js";
import { getServerI18n } from "../_lib/i18n.js";

export const dynamic = "force-dynamic";

function value(input, fallback = "") {
  return typeof input === "string" ? input : fallback;
}

export default async function DiscoverPage({ searchParams }) {
  await requireSetupReady();
  const { locale, t } = await getServerI18n();
  const params = await searchParams;
  const type = ["movie", "tv"].includes(value(params.type)) ? params.type : "all";
  const genre = value(params.genre);
  const page = value(params.page, "1");
  const [genreState, resultState] = await Promise.all([
    getGenreDefinitions("all", { locale }).then((genres) => ({ genres, error: "" })).catch((error) => ({ genres: [], error: error.message })),
    discoverCatalog({ type, genre, page, locale }).then((result) => ({ result, error: "" })).catch((error) => ({ result: null, error: error.message })),
  ]);
  const selectedGenre = genreState.genres.find((item) => item.slug === genre);
  const typeLabel = type === "movie" ? t("movies") : type === "tv" ? t("TV shows") : t("movies or TV shows");
  const emptyMessage = selectedGenre
    ? t("TMDB has no {genre} {type} for these filters.", { genre: selectedGenre.name, type: typeLabel })
    : t("TMDB has no {type} for these filters.", { type: typeLabel });
  const currentHref = catalogHref("/discover", { type, genre, page: Number(page) || 1 });

  return (
    <main className="shell homeShell">
      <AppHeader active="discover" />
      <section className="catalogHero compactCatalogHero">
        <span className="eyebrow">{t("Discover")}</span>
        <h1>{t("Browse without knowing the title.")}</h1>
        <p>{t("Explore popular movies and TV shows, then narrow the catalog by media type and genre.")}</p>
      </section>
      <CatalogFilters
        key={`${type}|${genre}`}
        pathname="/discover"
        initialType={type}
        initialGenre={genre}
        genres={genreState.genres}
      />
      {genreState.error ? <div className="notice error">{t("Genres are unavailable:")} {genreState.error}</div> : null}
      {resultState.error ? (
        <div className="notice error" role="alert">
          {resultState.error} <a className="inlineLink" href={currentHref}>{t("Retry")}</a>
        </div>
      ) : null}
      {resultState.result ? (
        <CatalogResults
          pathname="/discover"
          result={resultState.result}
          state={{ type, genre }}
          emptyMessage={emptyMessage}
        />
      ) : null}
      <CatalogFooter />
    </main>
  );
}
