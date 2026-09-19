import Image from "next/image";
import { notFound } from "next/navigation";
import AppHeader from "../../../components/AppHeader.js";
import ShowDetails from "../../../components/ShowDetails.js";
import { getSeasonDetails, getShowDetails } from "../../../lib/metadata/tmdb.js";
import { requireSetupReady } from "../../../lib/settings/gate.js";

export const dynamic = "force-dynamic";

export default async function ShowPage({ params, searchParams }) {
  await requireSetupReady();
  let show;
  let initialSeason = null;
  const query = await searchParams;
  try {
    const { id } = await params;
    show = await getShowDetails(id);
    const requestedSeason = Number(query?.season);
    const defaultSeason = show.seasons.find((season) => season.number === requestedSeason)
      ?? show.seasons.find((season) => season.number > 0) ?? show.seasons[0];
    if (defaultSeason) initialSeason = await getSeasonDetails(show.id, defaultSeason.number);
  } catch (error) {
    if (error.status === 404 || error.status === 400) notFound();
    return <main className="shell"><div className="notice error">{error.message}</div></main>;
  }

  return (
    <main className="shell detailShell">
      <AppHeader />
      <section className="detailsHero compactHero">
        {show.backdropUrl ? (
          <Image className="backdropImage" src={show.backdropUrl} alt="" fill priority sizes="100vw" />
        ) : null}
        <div className="backdropShade" />
        <div className="detailsContent">
          <div className="detailPoster">
            {show.posterUrl ? <Image src={show.posterUrl} alt={`${show.title} poster`} fill loading="eager" sizes="240px" /> : null}
          </div>
          <div className="detailCopy">
            <span className="eyebrow">Series</span>
            <h1>{show.title}</h1>
            <div className="detailMeta">
              {show.year ? <span>{show.year}</span> : null}
              {show.status ? <span>{show.status}</span> : null}
              {show.genres.length ? <span>{show.genres.join(" · ")}</span> : null}
            </div>
            <p>{show.overview || "No description is available."}</p>
          </div>
        </div>
      </section>
      {initialSeason ? <ShowDetails
        show={show}
        initialSeason={initialSeason}
        initialEpisodeNumber={Number(query?.episode) || null}
        initialIntent={query?.resume === "1" ? "resume" : query?.start === "1" ? "start" : null}
      /> : (
        <div className="notice">No seasons are available for this show.</div>
      )}
      <footer className="detailDisclaimer">Only select sources you are authorized to view.</footer>
    </main>
  );
}
