import AppHeader from "../../components/AppHeader.js";
import SettingsManager from "../../components/SettingsManager.js";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="shell homeShell">
      <AppHeader active="settings" />
      <section className="catalogHero compactCatalogHero">
        <span className="eyebrow">TorPlay settings</span>
        <h1>Configure services without exposing credentials.</h1>
        <p>Manage the integrations used for metadata, source discovery, subtitles, and playback.</p>
      </section>
      <SettingsManager />
    </main>
  );
}
