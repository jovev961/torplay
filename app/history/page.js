import AppHeader from "../../components/AppHeader.js";
import HistoryShelf from "../../components/HistoryShelf.js";

export default function HistoryPage() {
  return <main className="shell"><AppHeader active="history" /><HistoryShelf full /></main>;
}
