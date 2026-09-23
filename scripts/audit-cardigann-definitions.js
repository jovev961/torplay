import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDefinition } from "../lib/search/cardigann/definition.js";
import { analyzeCardigannConversion, summarizeConversionAnalysis } from "./lib/cardigann-conversion-analysis.js";

const argumentsList = process.argv.slice(2);
const directory = argumentsList.find((argument) => !argument.startsWith("--"));
const includeDetails = argumentsList.includes("--details");
const includeConversionAnalysis = argumentsList.includes("--conversion-analysis");
if (!directory) {
  console.error("Usage: npm run audit:cardigann -- /path/to/definitions/v11 [--details] [--conversion-analysis]");
  process.exitCode = 2;
} else {
  const entries = (await readdir(path.resolve(directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const report = { directory: path.resolve(directory), total: entries.length, compatible: [], unsupported: [], invalid: [] };

  for (const entry of entries) {
    const filename = path.join(report.directory, entry.name);
    try {
      const parsed = parseDefinition(await readFile(filename, "utf8"));
      report.compatible.push({
        file: entry.name,
        id: parsed.definition.id,
        mediaTypes: parsed.capabilities.mediaTypes,
        ...(includeConversionAnalysis ? { conversion: analyzeCardigannConversion(parsed.definition) } : {}),
      });
    } catch (error) {
      if (error.code === "CARDIGANN_UNSUPPORTED" && Array.isArray(error.unsupportedFeatures)) {
        report.unsupported.push({ file: entry.name, features: error.unsupportedFeatures });
      } else {
        report.invalid.push({ file: entry.name, message: error.message });
      }
    }
  }

  const featureCounts = {};
  for (const item of report.unsupported) {
    for (const feature of item.features) featureCounts[feature.feature] = (featureCounts[feature.feature] || 0) + 1;
  }
  const conversionDefinitions = includeConversionAnalysis
    ? report.compatible.map((item) => ({ analysis: item.conversion }))
    : [];
  console.log(JSON.stringify({
    directory: report.directory,
    total: report.total,
    compatible: report.compatible.length,
    unsupported: report.unsupported.length,
    invalid: report.invalid.length,
    unsupportedFeatures: featureCounts,
    invalidDefinitions: report.invalid,
    ...(includeConversionAnalysis ? { conversionAnalysis: summarizeConversionAnalysis(conversionDefinitions) } : {}),
    ...(includeDetails ? { definitions: report } : {}),
  }, null, 2));
  if (report.invalid.length) process.exitCode = 1;
}
