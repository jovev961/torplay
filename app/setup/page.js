import { redirect } from "next/navigation";
import SetupManager from "../../components/SetupManager.js";
import { getSetupStatus } from "../../lib/settings/readiness.js";
import styles from "../../components/SetupManager.module.css";
import LanguageSwitcher from "../../components/LanguageSwitcher.js";
import { getServerI18n } from "../_lib/i18n.js";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const { t } = await getServerI18n();
  const setup = await getSetupStatus();
  if (setup.ready) redirect("/");
  return (
    <main className={styles.setupShell}>
      <section className={styles.setupHero}>
        <LanguageSwitcher className="entryLanguageSwitcher" />
        <span className={styles.brand}>TORPLAY</span>
        <span className="eyebrow">{t("First-time setup")}</span>
        <h1>{t("Connect your movie and TV catalog.")}</h1>
        <p>{t("Your TMDB credential stays on this computer. Next, choose a third-party source for videos or continue browsing without one.")}</p>
      </section>
      <SetupManager />
    </main>
  );
}
