import { DateTime } from "luxon";
import { JSONPath } from "jsonpath-plus";

function argumentsFor(step) {
  if (step.args === undefined) return [];
  return Array.isArray(step.args) ? step.args : [step.args];
}
function relativeDate(value, now) {
  const text = String(value).toLowerCase().trim();
  if (text === "now" || text === "today") return DateTime.fromJSDate(now);
  if (text === "yesterday") return DateTime.fromJSDate(now).minus({ days: 1 });
  if (text === "tomorrow") return DateTime.fromJSDate(now).plus({ days: 1 });
  const units = { year: "years", month: "months", week: "weeks", day: "days", hour: "hours", hr: "hours", minute: "minutes", min: "minutes", second: "seconds", sec: "seconds" };
  const duration = {};
  for (const match of text.matchAll(/(\d+)\s*(years?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b/g)) {
    const raw = match[2].replace(/s$/, "");
    const key = units[raw] || ({ d: "days", h: "hours", m: "minutes", s: "seconds" })[raw];
    if (key) duration[key] = (duration[key] || 0) + Number(match[1]);
  }
  return Object.keys(duration).length ? DateTime.fromJSDate(now).minus(duration) : DateTime.invalid("Unsupported relative date");
}

function dotNetFormat(format) {
  return String(format || "").replaceAll("dddd", "cccc").replaceAll("ddd", "ccc").replaceAll("zzz", "ZZ").replaceAll("zz", "ZZ").replaceAll("tt", "a");
}

function htmlDecode(value) {
  return String(value).replace(/&(#x?[\da-f]+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hexadecimal = entity[0] === "#" && entity[1]?.toLowerCase() === "x";
    return String.fromCodePoint(Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10));
  });
}

export function applyFilters(input, filters = [], { now = new Date() } = {}) {
  let value = input ?? "";
  for (const step of filters) {
    const args = argumentsFor(step);
    const text = String(value ?? "");
    switch (step.name) {
      case "querystring": value = new URL(text, "https://cardigann.invalid").searchParams.get(String(args[0])) || ""; break;
      case "regexp": {
        const match = text.match(new RegExp(String(args[0] || ""), "i"));
        value = match?.[1] ?? match?.[0] ?? "";
        break;
      }
      case "re_replace": value = text.replace(new RegExp(String(args[0] || ""), "gi"), String(args[1] ?? "")); break;
      case "split": value = text.split(String(args[0] ?? ""))[Number(args[1] || 0)] ?? ""; break;
      case "replace": value = text.split(String(args[0] ?? "")).join(String(args[1] ?? "")); break;
      case "trim": value = args[0] === undefined ? text.trim() : text.replace(new RegExp(`^[${String(args[0]).replace(/[\\\]^]/g, "\\$&")}]+|[${String(args[0]).replace(/[\\\]^]/g, "\\$&")}]+$`, "g"), ""); break;
      case "prepend": value = `${args[0] ?? ""}${text}`; break;
      case "append": value = `${text}${args[0] ?? ""}`; break;
      case "tolower": value = text.toLowerCase(); break;
      case "toupper": value = text.toUpperCase(); break;
      case "urldecode": value = decodeURIComponent(text.replaceAll("+", " ")); break;
      case "urlencode": value = new URLSearchParams({ value: text }).toString().slice(6); break;
      case "htmldecode": value = htmlDecode(text); break;
      case "htmlencode": value = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); break;
      case "dateparse":
      case "timeparse": {
        const parsed = DateTime.fromFormat(text.trim(), dotNetFormat(args[0]), { setZone: true });
        value = parsed.isValid ? parsed.toUTC().toRFC2822() : "";
        break;
      }
      case "timeago":
      case "reltime": {
        const parsed = relativeDate(text, now);
        value = parsed.isValid ? parsed.toUTC().toRFC2822() : "";
        break;
      }
      case "fuzzytime": {
        let parsed = /^\d{10,13}$/.test(text.trim())
          ? DateTime.fromMillis(Number(text.trim()) * (text.trim().length === 10 ? 1000 : 1))
          : relativeDate(text, now);
        if (!parsed.isValid) parsed = DateTime.fromJSDate(new Date(text));
        value = parsed.isValid ? parsed.toUTC().toRFC2822() : "";
        break;
      }
      case "validfilename": value = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, ""); break;
      case "diacritics": value = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); break;
      case "jsonjoinarray": {
        const result = JSONPath({ path: String(args[0] || "$"), json: JSON.parse(text), wrap: true });
        value = result.flat().join(String(args[1] ?? ""));
        break;
      }
      case "validate": {
        const allowed = new Set(String(args[0] || "").split(",").map((item) => item.trim().replaceAll("_", " ").toLowerCase()));
        value = text.split(/[, /.)(;[\]"|:]+/).filter((item) => allowed.has(item.toLowerCase())).join(", ");
        break;
      }
      case "hexdump":
      case "strdump": break;
      default: throw new Error(`Unsupported Cardigann filter: ${step.name}.`);
    }
  }
  return value;
}
