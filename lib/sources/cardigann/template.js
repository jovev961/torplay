import { executeRegex } from "./regex.js";

const FUNCTIONS = new Set(["eq", "ne", "and", "or", "not", "join", "re_replace"]);
const BLOCKS = new Set(["if", "range", "else", "end"]);

function lex(expression) {
  const tokens = expression.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[()]|[^\s()]+/g) || [];
  if (tokens.length > 200) throw new Error("Cardigann expression is too large.");
  return tokens;
}

function expression(tokens) {
  let cursor = 0;
  function read(stop = false) {
    const parts = [];
    while (cursor < tokens.length && tokens[cursor] !== ")") {
      const token = tokens[cursor++];
      if (token === "(") {
        parts.push(read(true));
        if (tokens[cursor++] !== ")") throw new Error("Invalid template parentheses.");
      } else parts.push({ atom: token });
    }
    if (!stop && cursor !== tokens.length) throw new Error("Invalid template expression.");
    const first = parts[0]?.atom;
    if (parts.length > 1 && !FUNCTIONS.has(first)) throw new Error("Unsupported template function.");
    if (parts.length === 1 && first && !/^[.$'"\d-]/.test(first) && !["true", "false", "nil", "null"].includes(first)) throw new Error("Unsupported template expression.");
    return parts.length > 1 ? { call: first, args: parts.slice(1) } : parts[0] || { atom: '""' };
  }
  return read();
}

export function parseTemplate(value) {
  const source = String(value ?? "");
  const root = [];
  const stack = [{ children: root }];
  let cursor = 0;
  for (const match of source.matchAll(/{{\s*([\s\S]*?)\s*}}/g)) {
    const children = stack.at(-1).children;
    if (match.index > cursor) children.push({ text: source.slice(cursor, match.index) });
    const directive = match[1].trim();
    const tokens = lex(directive);
    const command = tokens[0];
    if (command === "if" || command === "range") {
      if (stack.length > 20) throw new Error("Template nesting is too deep.");
      let body = tokens.slice(1), names = [];
      if (command === "range" && directive.includes(":=")) {
        const assignment = directive.match(/^range\s+\$(\w+)(?:\s*,\s*\$(\w+))?\s*:=\s*(.+)$/);
        if (!assignment) throw new Error("Unsupported range assignment.");
        names = [assignment[1], assignment[2]].filter(Boolean);
        body = lex(assignment[3]);
      }
      const node = { command, expression: expression(body), names, children: [], alternate: [] };
      children.push(node);
      stack.push({ node, children: node.children });
    } else if (command === "else") {
      if (stack.length === 1 || tokens.length !== 1 || stack.at(-1).alternate) throw new Error("Invalid template else.");
      stack.at(-1).children = stack.at(-1).node.alternate;
      stack.at(-1).alternate = true;
    } else if (command === "end") {
      if (stack.length === 1 || tokens.length !== 1) throw new Error("Invalid template end.");
      stack.pop();
    } else {
      if (BLOCKS.has(command)) throw new Error("Unsupported template block.");
      children.push({ expression: expression(tokens) });
    }
    cursor = match.index + match[0].length;
  }
  if (stack.length !== 1 || source.slice(cursor).includes("{{")) throw new Error("Unclosed Cardigann template.");
  root.push({ text: source.slice(cursor) });
  return root;
}

function ownPath(object, parts) {
  return parts.reduce((value, key) => value && Object.hasOwn(value, key) && !["__proto__", "prototype", "constructor"].includes(key) ? value[key] : undefined, object);
}

async function evaluate(node, context, locals) {
  if (node.call) {
    const values = [];
    for (const item of node.args) values.push(await evaluate(item, context, locals));
    switch (node.call) {
      case "eq": return values.slice(1).every((item) => item === values[0]);
      case "ne": return values[0] !== values[1];
      case "and": return values.every(Boolean);
      case "or": return values.some(Boolean);
      case "not": return !values[0];
      case "join": return Array.isArray(values[0]) ? values[0].join(String(values[1] ?? "")) : "";
      case "re_replace": return executeRegex(String(values[0] ?? ""), String(values[1] ?? ""), { flags: "g", replacement: String(values[2] ?? "") });
    }
  }
  const atom = node.atom;
  if (atom.startsWith('"')) return JSON.parse(atom);
  if (atom.startsWith("'")) return atom.slice(1, -1);
  if (atom === "true" || atom === "false") return atom === "true";
  if (atom === "nil" || atom === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(atom)) return Number(atom);
  if (atom === ".") return locals["."] ?? context;
  if (atom.startsWith("$")) return ownPath(locals, atom.slice(1).split(".")) ?? "";
  return ownPath(context, atom.slice(1).split(".")) ?? "";
}

export async function renderTemplate(value, context = {}) {
  let emitted = 0;
  async function render(nodes, locals = {}) {
    let output = "";
    for (const node of nodes) {
      if (++emitted > 10_000) throw new Error("Template expansion is too large.");
      if (node.text !== undefined) output += node.text;
      else if (node.command === "if") output += await render(await evaluate(node.expression, context, locals) ? node.children : node.alternate, locals);
      else if (node.command === "range") {
        const collection = await evaluate(node.expression, context, locals);
        const entries = Array.isArray(collection) ? collection.map((item, index) => [index, item])
          : collection && typeof collection === "object" ? Object.entries(collection) : [];
        if (entries.length > 1000) throw new Error("Template range is too large.");
        if (!entries.length) output += await render(node.alternate, locals);
        for (const [key, item] of entries) output += await render(node.children, {
          ...locals, ...(node.names.length === 2 ? { [node.names[0]]: key, [node.names[1]]: item }
            : node.names.length ? { [node.names[0]]: item } : { ".": item }),
        });
      } else output += String(await evaluate(node.expression, context, locals) ?? "");
      if (output.length > 65_536) throw new Error("Template output is too large.");
    }
    return output;
  }
  return render(parseTemplate(value));
}
