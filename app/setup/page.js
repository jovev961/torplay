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
        <h1>Connect the two services TorPlay needs.</h1>
        <p>Your credentials stay on this computer. TorPlay verifies both connections before saving anything.</p>
      </section>
      <SetupManager />
    </main>
  );
}
