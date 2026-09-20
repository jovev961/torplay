import { eztvProvider } from "./eztv.js";
import { knabenProvider } from "./knaben.js";
import { ytsProvider } from "./yts.js";

export const TESTED_SOURCES = [ytsProvider, eztvProvider, knabenProvider];

export function testedSource(id) {
  return TESTED_SOURCES.find((source) => source.id === id) || null;
}
