import { redirect } from "next/navigation";
import { getSetupStatus } from "./readiness.js";

export async function requireSetupReady() {
  const status = await getSetupStatus();
  if (!status.ready) redirect("/setup");
}
