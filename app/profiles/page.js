import AppHeader from "../../components/AppHeader.js";
import ProfileManager from "../../components/ProfileManager.js";

export default async function ProfilesPage({ searchParams }) {
  const parameters = await searchParams;
  const startAdding = parameters?.add === "1";
  return (
    <main className="shell">
      <AppHeader />
      <ProfileManager key={startAdding ? "add" : "manage"} startAdding={startAdding} />
    </main>
  );
}
