import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

// The watchdog lives outside the process running source code: an event-loop
// stall must fail this test rather than disable its own timeout.
const scenario = String.raw`
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { search } from './lib/sources/discovery.js';
import { validateDefinitionObject } from './lib/sources/cardigann/definition.js';
import { definition, cardigann, html, movie, mockNetwork, torznab, rss } from './tests/helpers/sources-fixtures.js';
const mode = process.argv[1];
const ordinary = mode.startsWith('ordinary');
const def = definition();
const hostile = 'a'.repeat(36) + '!';
def.settings = [{name:'pattern',type:'text'}, {name:'payload',type:'text'}];
if (mode.includes('template')) {
  def.search.paths[0].inputs.q = '{{ re_replace .Config.payload .Config.pattern "" }}';
} else {
  def.search.fields.title.filters = [{name: mode === 'extraction' ? 'regexp' : 're_replace',
    args: [mode === 'rendered-filter' ? '{{ .Config.pattern }}' : ordinary ? '^prefix:' : '(a+)+$', '']}];
}
assert.equal(validateDefinitionObject(def).compatibility.supported, true);
const bad = {...cardigann(def), settings:{pattern:ordinary ? '^prefix:' : '(a+)+$',payload:ordinary ? 'prefix:The Tailor' : hostile}};
const calls = mockNetwork({mock}, ({url}) => ({body: url.hostname === 'good.example' ? rss(undefined, '', 'abcdef1234567890abcdef1234567890abcdef12') : html(ordinary ? mode.includes('template') ? 'The Tailor 2023' : 'prefix:The Tailor 2023' : hostile)}));
let ticks = 0;
const heartbeat = setInterval(() => ticks++, 10);
const controller = new AbortController();
const cancelling = mode.endsWith('cancel');
let cancellation;
const started = performance.now();
try {
  const operation = search(movie, {sources:[bad,torznab('good')],environment:{},refresh:true,
    timeoutMs:mode === 'deadline' ? 20 : 1000, signal:controller.signal});
  if (cancelling) cancellation = setTimeout(() => controller.abort(), 10);
  if (cancelling) {
    await assert.rejects(operation, {name:'AbortError'});
  } else {
    const result = await operation;
    assert.ok(result.candidates.some(c => c.sourceId === 'good'));
    const status = result.diagnostics.find(d => d.sourceId === bad.id).status;
    assert.equal(status, ordinary ? 'ready' : 'timed-out');
    if (ordinary) assert.ok(result.candidates.some(c => c.sourceId === bad.id && c.title === 'The Tailor 2023'));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|magnet:|fixture\.example|good\.example|\(a\+\)\+\$/);
  }
  assert.ok(performance.now() - started < 2000, 'source processing must remain bounded');
  assert.ok(ticks > 0, 'event loop must progress during regex processing');
  if (!mode.includes('template')) assert.ok(calls.some(c => c.url.hostname === 'fixture.example'));
} finally {
  clearInterval(heartbeat); clearTimeout(cancellation); mock.restoreAll();
}
// No process.exit(): natural child exit verifies regex workers do not remain alive.
console.log('verified');
`;

for (const mode of ["deadline", "replacement", "extraction", "rendered-filter", "template", "template-cancel", "replacement-cancel", "ordinary", "ordinary-template"]) {
  test(`Cardigann regex isolation and cleanup: ${mode}`, { timeout: 10_000 }, async () => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", scenario, mode], {
        cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", timedOut = false;
      const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", error => { clearTimeout(watchdog); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(watchdog); resolve({ code, signal, timedOut, output }); });
    });
    assert.equal(result.timedOut, false, "external watchdog killed stalled source processing or lingering workers");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /verified/);
  });
}
