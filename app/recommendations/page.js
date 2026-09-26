import AppHeader from "../../components/AppHeader.js";
import CatalogFilters from "../../components/CatalogFilters.js";
import RecommendationsClient from "../../components/RecommendationsClient.js";
import { getGenreDefinitions } from "../../lib/metadata/tmdb.js";
import { requireSetupReady } from "../_lib/require-setup.js";
import { getServerI18n } from "../_lib/i18n.js";

export const dynamic = "force-dynamic";

export default async function RecommendationsPage({ searchParams }) {
  await requireSetupReady();
  const { locale, t } = await getServerI18n();
  const params = await searchParams;
  const mode = params.mode === "all" ? "all" : "recent";
  const type = ["movie", "tv"].includes(params.type) ? params.type : "all";
  const genreSlug = typeof params.genre === "string" ? params.genre : "";
  const genreState = await getGenreDefinitions("all", { locale })
    .then((genres) => ({ genres, error: "" }))
    .catch((error) => ({ genres: [], error: error.message }));
  const genre = genreState.genres.find((item) => item.slug === genreSlug) || null;
  return (
    <main className="shell homeShell">
      <AppHeader active="recommendations" />
      <section className="catalogHero compactCatalogHero">
        <span className="eyebrow">{t("Recommendations")}</span>
        <h1>{t("Find your next watch.")}</h1>
        <p>{t("Movies and shows suggested from the active profile's watch history.")}</p>
      </section>
      <CatalogFilters
        key={`${mode}|${type}|${genre?.slug || ""}`}
        pathname="/recommendations"
        initialType={type}
        initialGenre={genre?.slug || ""}
        mode={mode}
        genres={genreState.genres}
      />
      {genreState.error ? <div className="notice error">{t("Genres are unavailable:")} {genreState.error}</div> : null}
      <RecommendationsClient mode={mode} type={type} genre={genre} />
    </main>
  );
}
