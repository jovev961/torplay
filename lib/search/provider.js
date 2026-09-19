import { searchJackett } from "./jackett.js";

// The configured adapter is selected here, never by search or playback consumers.
export function searchConfiguredProvider(mediaContext) {
  return searchJackett(mediaContext);
}
