import { redirect } from "next/navigation";
import SetupManager from "../../components/SetupManager.js";
import { getSetupStatus } from "../../lib/settings/readiness.js";
import styles from "../../components/SetupManager.module.css";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const setup = await getSetupStatus();
  if (setup.ready) redirect("/");
  return (
    <main className={styles.setupShell}>
      <section className={styles.setupHero}>
        <span className={styles.brand}>TORPLAY</span>
        <span className="eyebrow">First-time setup</span>
        <h1>Connect your movie and TV catalog.</h1>
        <p>Your TMDB credential stays on this computer. Built-in torrent sources work without an external search service.</p>
      </section>
      <SetupManager />
    </main>
  );
}
