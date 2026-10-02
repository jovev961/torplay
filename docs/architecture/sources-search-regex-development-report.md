# Cardigann regex execution correction — Develop

Task: `docs/tasks/reviewer/sources-search--bound-cardigann-regex-execution.md`.
Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Issue: [#145](https://github.com/jovev961/torplay/issues/145). Branch: `develop`.

## Production correction

Definition-controlled `regexp`, filter `re_replace`, and template `re_replace`
execute asynchronously in a Node worker. One worker is created lazily per source
execution and reused for its regex operations. Private download resolution owns
a fresh execution scope. Operations in a scope are serialized so concurrent
requests cannot consume each other's results. No network policy changed.

The existing source AbortSignal terminates the worker on source timeout or caller
cancellation. A regex operation additionally has a 50 ms processing limit;
worker startup has a 1 second ceiling, also interrupted by the source signal.
Normal completion and processing failures terminate the worker. Only bounded
string data crosses the worker boundary; no definition-provided code executes.

Patterns are limited to 4096 characters, input/output to 5 MiB, replacement
strings to 4096 characters, and conservatively estimated replacement allocation
to 16 MiB. Patterns are checked both during static filter compatibility and after
runtime rendering. Expensive or oversized operations produce safe timed-out or
unsupported diagnostics. The worker has bounded V8 heap limits. Definitions
that exceed these limits can be unsupported even when their regex syntax is valid.

Filters, templates and their engine callers now await processing. JavaScript
capture/replacement semantics and existing filter/template flags are retained.
The worker uses `.mjs` so the traced Next build asset loads as an ES module.

## Development verification

- Exact review reproduction, retaining its external eight-second subprocess
  timeout: completed in 21 ms rather than about 3.2 seconds; the independent timer
  fired, the healthy sibling returned one candidate, and the hostile source was
  timed out.
- Inline diagnostic subprocesses with eight-second limits: normal captures,
  replacement capture expansion, template replacement and concurrent regex calls
  returned expected values. Hostile extraction, rendered filter patterns and
  template patterns timed out in 63–64 ms with the independent timer responsive.
  Cancellation during warmed-worker backtracking returned `AbortError`.
- Full discovery and private resolution diagnostic: template request replacement,
  response preprocessing, title filter and download extraction produced a ready
  candidate and a validated private resolution.
- `node --test tests/sources-*.test.js`: 144 passed, including credential-origin
  and Cookie checks. Tests were not changed or created.
- Focused ESLint for the six changed/new Cardigann modules: passed.
- `npm run build`: passed. The traced worker asset was additionally launched
  directly and returned the expected capture result. An initial `.js` asset load
  failure was corrected by using `.mjs` before completion.
- `git diff --check`: passed.

No commit, push, issue closure, merge or deployment. Existing unrelated work was
preserved. The Reviewer task remains for independent Test and final Review.
Live definitions/endpoints were not verified. Independent Test must add permanent
regression coverage with an external process timeout and complete the parent gate.
