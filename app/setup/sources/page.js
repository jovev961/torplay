import { redirect } from "next/navigation";
import { getSetupStatus } from "../../../lib/settings/readiness.js";
import SourceOnboarding from "../../../components/SourceOnboarding.js";
import styles from "../../../components/SetupManager.module.css";

export const dynamic = "force-dynamic";

export default async function SourceSetupPage() {
  if (!(await getSetupStatus()).ready) redirect("/setup");
  return <main className={styles.setupShell}>
    <section className={styles.setupHero}>
      <span className={styles.brand}>TORPLAY</span>
      <h1>Choose where to find videos.</h1>
      <p>Add a third-party source for movie and TV searches, or skip this step and browse the catalog first.</p>
    </section>
    <SourceOnboarding />
  </main>;
}
