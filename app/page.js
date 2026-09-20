import MediaBrowser from "../components/MediaBrowser.js";
import AppHeader from "../components/AppHeader.js";
import CatalogFooter from "../components/CatalogFooter.js";
import HistoryShelf from "../components/HistoryShelf.js";
import { getTrending } from "../lib/metadata/tmdb.js";
import { requireSetupReady } from "./_lib/require-setup.js";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireSetupReady();
  const [movieResult, showResult] = await Promise.allSettled([
    getTrending("movie"),
    getTrending("tv"),
  ]);
  const movies = movieResult.status === "fulfilled" ? movieResult.value : [];
  const shows = showResult.status === "fulfilled" ? showResult.value : [];
  const movieError = movieResult.status === "rejected" ? movieResult.reason.message : "";
  const showError = showResult.status === "rejected" ? showResult.reason.message : "";

  return (
    <main className="shell homeShell">
      <AppHeader active="home" />
      <section className="catalogHero">
        <span className="eyebrow">Metadata by TMDB · Authorized torrent sources</span>
        <h1>Browse first. Choose an authorized source when you are ready.</h1>
        <p>Explore movie and series metadata without mixing it with torrent availability.</p>
      </section>

      <HistoryShelf />
      <MediaBrowser movies={movies} shows={shows} movieError={movieError} showError={showError} />

      <CatalogFooter />
    </main>
  );
}
