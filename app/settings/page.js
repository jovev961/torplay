import AppHeader from "../../components/AppHeader.js";
import SettingsManager from "../../components/SettingsManager.js";
import { getServerI18n } from "../_lib/i18n.js";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { t } = await getServerI18n();
  return (
    <main className="shell homeShell">
      <AppHeader active="settings" />
      <section className="settingsHero">
        <span className="eyebrow">{t("Make TorPlay yours")}</span>
        <h1>{t("Settings")}</h1>
        <p>{t("Connect the services you use, choose where videos come from, and adjust how they play.")}</p>
      </section>
      <SettingsManager />
    </main>
  );
}
