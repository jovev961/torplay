import { getServerI18n } from "../_lib/i18n.js";

export default async function DiscoverLoading() {
  const { t } = await getServerI18n();
  return <main className="shell"><div className="notice">{t("Loading discovery results…")}</div></main>;
}
