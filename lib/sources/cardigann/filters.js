import { executeRegex } from "./regex.js";
import { DateTime } from "luxon";
import { load } from "cheerio";
import { JSONPath } from "jsonpath-plus";

export const CARDIGANN_FILTERS = new Set(["querystring", "timeparse", "dateparse", "regexp", "re_replace", "split", "replace", "trim",
  "prepend", "append", "tolower", "toupper", "urldecode", "urlencode", "htmldecode", "htmlencode", "timeago", "reltime", "fuzzytime",
  "validfilename", "diacritics", "jsonjoinarray", "hexdump", "strdump", "validate"]);

function relative(value, now) {
  const text = value.toLowerCase().trim();
  const base = DateTime.fromJSDate(now);
  if (["now", "today"].includes(text)) return base;
  if (text === "yesterday") return base.minus({ days: 1 });
  if (text === "tomorrow") return base.plus({ days: 1 });
  const duration = {};
  const units = { y: "years", month: "months", w: "weeks", d: "days", h: "hours", m: "minutes", s: "seconds" };
  for (const match of text.matchAll(/(\d+)\s*(years?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b/g)) {
    const unit = match[2].startsWith("month") ? "months" : units[match[2][0]];
    duration[unit] = (duration[unit] || 0) + Number(match[1]);
  }
  return Object.keys(duration).length ? base.minus(duration) : DateTime.invalid("Invalid relative date");
}

export async function applyFilters(input, steps = [], { render = String, now = new Date() } = {}) {
  let value = input ?? "";
  for (const step of steps) {
    const args = [];
    for (const argument of Array.isArray(step.args) ? step.args : step.args === undefined ? [] : [step.args]) {
      args.push(typeof argument === "string" ? await render(argument) : argument);
    }
    const string = String(value ?? "");
    const pattern = String(args[0] || "").replace(/^\(\?i\)/, "");
    switch (step.name) {
      case "querystring": value = new URL(string, "https://definition.invalid").searchParams.get(String(args[0])) || ""; break;
      case "regexp": { const match = await executeRegex(string, pattern); value = match?.[1] ?? match?.[0] ?? ""; break; }
      case "re_replace": value = await executeRegex(string, pattern, { replacement: String(args[1] ?? "") }); break;
      case "replace": value = string.split(String(args[0] ?? "")).join(String(args[1] ?? "")); break;
      case "split": value = string.split(String(args[0] ?? ""))[Number(args[1] || 0)] ?? ""; break;
      case "trim": {
        if (args[0] === undefined) value = string.trim();
        else { const chars = new Set(String(args[0])); let start = 0, end = string.length;
          while (start < end && chars.has(string[start])) start++;
          while (end > start && chars.has(string[end - 1])) end--;
          value = string.slice(start, end); }
        break;
      }
      case "prepend": value = `${args[0] ?? ""}${string}`; break;
      case "append": value = `${string}${args[0] ?? ""}`; break;
      case "tolower": value = string.toLowerCase(); break;
      case "toupper": value = string.toUpperCase(); break;
      case "urldecode": value = decodeURIComponent(string.replaceAll("+", " ")); break;
      case "urlencode": value = new URLSearchParams({ value: string }).toString().slice(6); break;
      case "htmldecode": value = load(string, null, false).root().text(); break;
      case "htmlencode": value = string.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); break;
      case "diacritics": value = string.normalize("NFKD").replace(/\p{Diacritic}/gu, ""); break;
      case "validfilename": value = string.replace(/[<>:"/\\|?*\x00-\x1f]/g, ""); break;
      case "jsonjoinarray": value = JSONPath({ json: JSON.parse(string), path: String(args[0] || "$"), eval: false }).flat().join(String(args[1] ?? "")); break;
      case "validate": {
        const choices = new Set(String(args[0] || "").split(",").map((item) => item.trim().replaceAll("_", " ").toLowerCase()));
        value = string.split(/[,\s/.)(;[\]"|:]+/).filter((item) => choices.has(item.toLowerCase())).join(", "); break;
      }
      case "timeparse": case "dateparse": {
        const format = String(args[0] || "").replaceAll("dddd", "cccc").replaceAll("ddd", "ccc").replaceAll("zzz", "ZZ").replaceAll("zz", "ZZ").replaceAll("tt", "a");
        const date = DateTime.fromFormat(string.trim(), format, { setZone: true });
        value = date.isValid ? date.toUTC().toRFC2822() : ""; break;
      }
      case "timeago": case "reltime": case "fuzzytime": {
        let date = relative(string, now);
        if (step.name === "fuzzytime" && !date.isValid) date = /^\d{10,13}$/.test(string.trim())
          ? DateTime.fromMillis(Number(string) * (string.trim().length === 10 ? 1000 : 1)) : DateTime.fromJSDate(new Date(string));
        value = date.isValid ? date.toUTC().toRFC2822() : ""; break;
      }
      case "hexdump": case "strdump": break; // Diagnostic-only filters never log source data.
      default: throw new Error("Unsupported Cardigann filter.");
    }
  }
  return value;
}
