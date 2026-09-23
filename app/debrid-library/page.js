import AppHeader from "../../components/AppHeader.js";
import DebridLibraryClient from "../../components/DebridLibraryClient.js";
import { requireSetupReady } from "../_lib/require-setup.js";

export const dynamic = "force-dynamic";

export default async function DebridLibraryPage() {
  await requireSetupReady();
  return <main className="shell"><AppHeader active="debrid-library" /><DebridLibraryClient /></main>;
}
