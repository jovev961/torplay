import AppHeader from "../../components/AppHeader.js";
import ProfileManager from "../../components/ProfileManager.js";

export default function ProfilesPage() {
  return <main className="shell"><AppHeader active="profiles" /><ProfileManager /></main>;
}
