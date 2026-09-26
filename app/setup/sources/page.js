import { redirect } from "next/navigation";
import { getSetupStatus } from "../../../lib/settings/readiness.js";
import SourceOnboarding from "../../../components/SourceOnboarding.js";
import styles from "../../../components/SetupManager.module.css";
import LanguageSwitcher from "../../../components/LanguageSwitcher.js";
import { getServerI18n } from "../../_lib/i18n.js";

export const dynamic = "force-dynamic";

export default async function SourceSetupPage() {
  const { t } = await getServerI18n();
  if (!(await getSetupStatus()).ready) redirect("/setup");
  return <main className={styles.setupShell}>
    <section className={styles.setupHero}>
      <LanguageSwitcher className="entryLanguageSwitcher" />
      <span className={styles.brand}>TORPLAY</span>
      <h1>{t("Choose where to find videos.")}</h1>
      <p>{t("Add a third-party source for movie and TV searches, or skip this step and browse the catalog first.")}</p>
    </section>
    <SourceOnboarding />
  </main>;
}
