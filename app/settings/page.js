import AppHeader from "../../components/AppHeader.js";
import SettingsManager from "../../components/SettingsManager.js";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="shell homeShell">
      <AppHeader active="settings" />
      <section className="settingsHero">
        <span className="eyebrow">Make TorPlay yours</span>
        <h1>Settings</h1>
        <p>Connect the services you use, choose where videos come from, and adjust how they play.</p>
      </section>
      <SettingsManager />
    </main>
  );
}
