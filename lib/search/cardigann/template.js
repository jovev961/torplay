const FUNCTIONS = new Set(["eq", "ne", "and", "or", "not", "join", "re_replace"]);

function tokens(expression) {
  return expression.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
}

function pathValue(path, context, locals) {
  if (path.startsWith("$")) return locals[path.slice(1)];
  if (!path.startsWith(".")) return undefined;
  return path.slice(1).split(".").filter(Boolean).reduce((value, key) => value?.[key], context);
}

function atom(token, context, locals) {
  if (token === undefined) return "";
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    try { return JSON.parse(token.startsWith("'") ? `"${token.slice(1, -1).replaceAll('"', '\\"')}"` : token); }
    catch { return token.slice(1, -1); }
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "nil" || token === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  const value = pathValue(token, context, locals);
  return value === undefined ? token : value;
}

function evaluate(expression, context, locals) {
  let expanded = String(expression).trim();
  const nestedLocals = { ...locals };
  let nestedIndex = 0;
  while (/\([^()]*\)/.test(expanded)) {
    expanded = expanded.replace(/\(([^()]*)\)/g, (_match, inner) => {
      const key = `__expression${nestedIndex++}`;
      nestedLocals[key] = evaluate(inner, context, nestedLocals);
      return `$${key}`;
    });
  }
  const parts = tokens(expanded);
  if (!parts.length) return "";
  const [name, ...args] = parts;
  if (!FUNCTIONS.has(name)) return atom(name, context, nestedLocals);
  const values = args.map((argument) => evaluate(argument, context, nestedLocals));
  if (name === "eq") return values.every((value) => value === values[0]);
  if (name === "ne") return values.length === 2 && values[0] !== values[1];
  if (name === "and") return values.every(Boolean);
  if (name === "or") return values.some(Boolean);
  if (name === "not") return !values[0];
  if (name === "join") {
    const array = Array.isArray(values[0]) ? values[0] : [];
    return array.join(String(values[1] ?? ""));
  }
  if (name === "re_replace") return String(values[0] ?? "").replace(new RegExp(String(values[1] ?? ""), "g"), String(values[2] ?? ""));
  return "";
}

function findBlock(nodes, start) {
  let depth = 0;
  let alternate = -1;
  for (let index = start; index < nodes.length; index += 1) {
    const directive = nodes[index].directive;
    if (/^(if|range)\b/.test(directive)) depth += 1;
    else if (directive === "end") {
      if (depth === 0) return { end: index, alternate };
      depth -= 1;
    } else if (directive === "else" && depth === 0) alternate = index;
  }
  throw new Error("Cardigann template contains an unclosed block.");
}

function renderNodes(nodes, context, locals = {}) {
  let output = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.text !== undefined) { output += node.text; continue; }
    const directive = node.directive;
    if (/^if\s+/.test(directive)) {
      const block = findBlock(nodes, index + 1);
      const truthy = Boolean(evaluate(directive.slice(3), context, locals));
      const start = truthy ? index + 1 : block.alternate >= 0 ? block.alternate + 1 : block.end;
      const end = truthy && block.alternate >= 0 ? block.alternate : block.end;
      output += renderNodes(nodes.slice(start, end), context, locals);
      index = block.end;
      continue;
    }
    if (/^range\s+/.test(directive)) {
      const block = findBlock(nodes, index + 1);
      const expression = directive.slice(6).trim();
      const assignment = expression.match(/^\$(\w+)(?:\s*,\s*\$(\w+))?\s*:=\s*(.+)$/);
      const collection = evaluate(assignment ? assignment[3] : expression, context, locals);
      const values = Array.isArray(collection) ? collection : collection && typeof collection === "object" ? Object.entries(collection) : [];
      values.forEach((value, itemIndex) => {
        const nextLocals = { ...locals };
        if (assignment?.[2]) { nextLocals[assignment[1]] = itemIndex; nextLocals[assignment[2]] = value; }
        else if (assignment) nextLocals[assignment[1]] = value;
        else nextLocals["."] = value;
        output += renderNodes(nodes.slice(index + 1, block.alternate >= 0 ? block.alternate : block.end), context, nextLocals);
      });
      if (!values.length && block.alternate >= 0) output += renderNodes(nodes.slice(block.alternate + 1, block.end), context, locals);
      index = block.end;
      continue;
    }
    if (["else", "end"].includes(directive)) throw new Error("Cardigann template contains an unexpected block marker.");
    output += String(evaluate(directive, context, locals) ?? "");
  }
  return output;
}

export function parseTemplate(value) {
  const source = String(value ?? "");
  const nodes = [];
  let cursor = 0;
  for (const match of source.matchAll(/{{\s*([\s\S]*?)\s*}}/g)) {
    if (match.index > cursor) nodes.push({ text: source.slice(cursor, match.index) });
    const directive = match[1].trim();
    const first = tokens(directive)[0];
    if (first && !["if", "else", "end", "range"].includes(first)
      && !FUNCTIONS.has(first) && !first.startsWith(".") && !first.startsWith("$")
      && !/^['"\d-]/.test(first) && !["true", "false", "nil", "null"].includes(first)) {
      throw new Error(`Unsupported Cardigann template function: ${first}.`);
    }
    nodes.push({ directive });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push({ text: source.slice(cursor) });
  renderNodes(nodes, {}, {});
  return nodes;
}

export function renderTemplate(value, context) {
  return renderNodes(parseTemplate(value), context);
}
