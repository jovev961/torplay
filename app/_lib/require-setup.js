import { redirect } from "next/navigation";
import { getSetupStatus } from "../../lib/settings/readiness.js";

export async function requireSetupReady() {
  const status = await getSetupStatus();
  if (!status.ready) redirect("/setup");
}
