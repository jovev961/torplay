import { getServerI18n } from "../_lib/i18n.js";

export default async function SearchLoading() {
  const { t } = await getServerI18n();
  return <main className="shell"><div className="notice">{t("Loading search results…")}</div></main>;
}
