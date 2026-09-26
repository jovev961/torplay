import MediaBrowser from "../components/MediaBrowser.js";
import AppHeader from "../components/AppHeader.js";
import CatalogFooter from "../components/CatalogFooter.js";
import HistoryShelf from "../components/HistoryShelf.js";
import RecommendationsClient from "../components/RecommendationsClient.js";
import { getTrending } from "../lib/metadata/tmdb.js";
import { requireSetupReady } from "./_lib/require-setup.js";
import { getServerI18n } from "./_lib/i18n.js";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireSetupReady();
  const { locale, t } = await getServerI18n();
  const [movieResult, showResult] = await Promise.allSettled([
    getTrending("movie", { locale }),
    getTrending("tv", { locale }),
  ]);
  const movies = movieResult.status === "fulfilled" ? movieResult.value : [];
  const shows = showResult.status === "fulfilled" ? showResult.value : [];
  const movieError = movieResult.status === "rejected" ? movieResult.reason.message : "";
  const showError = showResult.status === "rejected" ? showResult.reason.message : "";

  return (
    <main className="shell homeShell">
      <AppHeader active="home" />
      <section className="catalogHero">
        <span className="eyebrow">{t("Metadata by TMDB · Authorized torrent sources")}</span>
        <h1>{t("Browse first. Choose an authorized source when you are ready.")}</h1>
        <p>{t("Explore movie and series metadata without mixing it with torrent availability.")}</p>
      </section>

      <HistoryShelf />
      <MediaBrowser movies={movies} shows={shows} movieError={movieError} showError={showError}>
        <RecommendationsClient mode="recent" shelf />
      </MediaBrowser>

      <CatalogFooter />
    </main>
  );
}
