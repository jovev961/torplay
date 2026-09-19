import Image from "next/image";
import { notFound } from "next/navigation";
import AppHeader from "../../../components/AppHeader.js";
import MovieSource from "../../../components/MovieSource.js";
import { getMovieDetails } from "../../../lib/metadata/tmdb.js";
import { requireSetupReady } from "../../../lib/settings/gate.js";

export const dynamic = "force-dynamic";

export default async function MoviePage({ params, searchParams }) {
  await requireSetupReady();
  let movie;
  try {
    const { id } = await params;
    movie = await getMovieDetails(id);
  } catch (error) {
    if (error.status === 404 || error.status === 400) notFound();
    return <main className="shell"><div className="notice error">{error.message}</div></main>;
  }
  const query = await searchParams;
  const initialIntent = query?.resume === "1" ? "resume" : query?.start === "1" ? "start" : null;

  return (
    <main className="shell detailShell">
      <AppHeader />
      <section className="detailsHero">
        {movie.backdropUrl ? (
          <Image className="backdropImage" src={movie.backdropUrl} alt="" fill priority sizes="100vw" />
        ) : null}
        <div className="backdropShade" />
        <div className="detailsContent">
          <div className="detailPoster">
            {movie.posterUrl ? <Image src={movie.posterUrl} alt={`${movie.title} poster`} fill loading="eager" sizes="240px" /> : null}
          </div>
          <div className="detailCopy">
            <span className="eyebrow">Movie</span>
            <h1>{movie.title}</h1>
            <div className="detailMeta">
              {movie.year ? <span>{movie.year}</span> : null}
              {movie.runtime ? <span>{movie.runtime} min</span> : null}
              {movie.genres.length ? <span>{movie.genres.join(" · ")}</span> : null}
            </div>
            <p>{movie.overview || "No description is available."}</p>
          </div>
        </div>
      </section>
      <MovieSource movie={movie} initialIntent={initialIntent} />
      <footer className="detailDisclaimer">Only select sources you are authorized to view.</footer>
    </main>
  );
}
