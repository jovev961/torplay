# Final Sources/Search Review — 2026-10-02

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Issue: #145. Final independent verification passed. Approved publication branch:
`review/sources-search-reinvention`, based on `4ddc720`.

## Findings and acceptance criteria

No remaining blocking findings. Reviewed the original task and its 25 acceptance
criteria, current AGENTS.md, independently recorded plan and tests, current scoped
implementation/diffs, consumer contracts and all four retained Reviewer tasks.
The latest independent Test report records complete-parent PASS including the
new hostile-regex subprocess coverage; no parent Tester tasks remain.

The replacement has one active implementation, explicit source configuration and
migration, small native/Torznab/Cardigann adapters, neutral relevance/provenance,
expiring typed opaque results and private resolution. Acquisition inspection stays
outside discovery. Generic persistence and network policy retain their ownership;
obsolete Sources code and imports are removed. No new dependencies are introduced.
All explicitly listed episodes remain eligible while contradictions are rejected.
Sensitive download headers and configured/server-set cookies remain origin-bound.
Regex filter/template execution is terminable, deadline/cancellation-aware and
covered by an external watchdog with natural child exit for cleanup verification.
The production build emits and traces the worker asset required by the route.

Removed all four resolved parent Reviewer tasks after these final checks. No
production application code or tests were changed by Review. Historical findings
and gate failures below are superseded by this final verification.

## Checks executed

| Command | Working tree | Isolated publication snapshot |
| --- | --- | --- |
| `node --test tests/sources-*.test.js` | 153 passed | Included in unit suite |
| `npm run test:unit` | 541 passed | 527 passed |
| `npm run test:integration` | Sandbox EPERM; permitted rerun 101 passed | Permitted run 95 passed |
| `npm run lint` | Passed | Passed |
| `npm run build --ignore-scripts` | Passed | Passed |
| `git diff --check` | Passed | Passed |

All passing suites have zero failures, cancellations or skips. Build intentionally
omitted the prebuild icon mutation hook. Working-tree logs:
`/tmp/torplay-review-current-{sources,unit,integration-approved,lint,build}.log`.
Snapshot logs: `/tmp/torplay-review-scoped-{unit,integration,lint,build}.log`.
`gh issue view 145 --json number,title,state,url` verified the tracking issue OPEN
before publication.

## Publication scope and limitations

Prepared a fresh isolated local clone from HEAD plus only the approved Sources
files, independent replacement tests and source-specific documentation. Excluded
unrelated Watch Together, playback, translations, general architecture maps and
AGENTS.md edits. Lower snapshot counts reflect those excluded tests. The original
workspace remains on `develop` with unrelated work intact. Publication uses the
isolated feature branch; it does not push or merge `develop` or deploy/release.
Task directories are ignored workflow state and are not forced into the commit.

Inspected the latest independent Test's fresh native-browser onboarding evidence;
Review did not repeat browser interactions. No live providers, external solver,
full external definition corpus or external acquisition/playback were exercised.
Synthetic protocol tests establish the supported generic contract, not universal
live endpoint availability. Historical clean-room provenance cannot be proved
from a final tree alone; inspection found no runtime old/new compatibility maze.

---

# Sources/Search final review — 2026-10-01

## Latest review gate recheck — 2026-10-02

**CHANGES REQUIRED.** The current regex correction passes the original bounded
diagnostic, but its required permanent independent hostile-regex regression is
absent. Updated the existing regex Reviewer task rather than creating a duplicate.
The older runtime failure and review results below remain historical evidence.

### Evidence and checks

- Inspected current workflow rules, the primary requirements and retained
  corrective tasks, independent Test evidence, regex development report, current
  test inventory/assertions and working-tree scope.
- `node --test tests/sources-*.test.js`: 144 passed; no failures, cancellations
  or skips. Log: `/tmp/torplay-review-20261002-sources.log`.
- Original regex reproduction extracted unchanged from the Reviewer task and
  run via `subprocess.run(..., timeout=8)`: exit 0, 22 ms elapsed under a 20 ms
  source deadline; independent timer fired, one healthy candidate returned,
  diagnostics `ready` and `timed-out`. This supports the runtime correction,
  without establishing every regex entry point or cancellation/cleanup case.
- Test inventory and targeted assertion inspection found no permanent
  hostile-regex subprocess regression; `tests/sources-regex-isolation.test.js`
  is absent. Existing provider timeout checks do not exercise backtracking.
- `git diff --check`: passed before documentation changes; rechecked afterward.
- `gh issue view 145 --json number,title,state,url`: sandbox network access
  failed; permitted rerun verified issue #145 OPEN.

### Gate and next step

The independent Test report's latest recorded pass concerns the Cookie correction
and does not verify the later regex regression requirement. Fresh Test must add
the required externally bounded coverage and complete parent verification before
final Review can resolve the regex finding. No automatic switch to Test occurred.

The remaining full implementation audit, unit/integration, surrounding, lint,
build, browser and publication checks were deferred at this gate as planned.
This recheck grants no final resolution of any Reviewer task. All four remain;
there are currently no parent Tester tasks. Current branch: `develop`.

Only this report and the existing regex Reviewer task were updated. Production
code, tests and unrelated Watch Together/playback changes were preserved. No
task deletion, staging, branch change, commit, push, issue closure, merge or
deployment occurred.

Next: `test docs/tasks/develop/torplay-develop-reinvent-sources-search.md`, then
fresh final Review after complete-parent success.

## Current Review after credential/Cookie correction

**CHANGES REQUIRED.** A schema-valid Cardigann regex blocks the shared server
event loop and bypasses source deadlines. A 29-character synthetic response took
3,208 ms under a 20 ms source deadline. Both the affected source and its healthy
Torznab sibling reported `ready`; an independent 20 ms timer had not fired when
discovery completed. The definition was classified compatible. A preceding
single-source run with a shorter input returned `ready` after 229 ms.

New corrective task:
`docs/tasks/reviewer/sources-search--bound-cardigann-regex-execution.md`.
It contains exact reproduction with an eight-second outer process limit,
affected requirements/components and acceptance criteria. Only DNS/HTTP sockets
were mocked. No live credentials or larger hostile payloads were used.

### Current assessment and previous findings

Read the complete primary task, AGENTS.md, independent plan/report and all three
existing Reviewer tasks. Inspected configuration/migration, adapters, generic
Cardigann interpreter/transport, community import, normalized contract,
relevance/discovery/private results, shared network/persistence foundations,
acquisition inspection, migrated API/UI consumers, Debrid/Usenet boundaries,
documentation and independent replacement tests. Inspected the complete change
inventory and relevant diffs to distinguish unrelated work.

The runtime has one Sources implementation; inspected consumers have no obsolete
imports. Discovery does not own acquisition/playback lifecycle. Private temporary
typed resolution, explicit configuration, neutral ranking/provenance and
conservative mirrors retain the intended ownership. Historical clean-room
provenance cannot be conclusively established from the final tree.

The three previous Reviewer findings are behaviorally resolved in the current
tree: all explicitly listed episodes are handled; the latest independent Test
report records complete-parent PASS after the Cookie correction, with no parent
Tester tasks remaining; and the 39 credential tests verify origin restrictions,
initial/selector/preparation destinations, redirects, sensitive headers, HTTPS,
same-origin configured Cookie/cookie-jar authentication and credential-free
cross-origin downloads. Their historical failure evidence below is superseded.
All three Reviewer tasks remain because final parent Review has not passed.

Issue #145 was verified OPEN using
`gh issue view 145 --json number,title,state,url,body`. Branch remains `develop`.

### Checks executed in this Review

| Exact command | Result | Log |
| --- | --- | --- |
| `node --test tests/sources-*.test.js` | 144 passed; no failures/skips | `/tmp/torplay-review-current-sources.log` |
| `npm run test:unit` | 532 passed; no failures/skips | `/tmp/torplay-review-current-unit.log` |
| `npm run test:integration` | Sandbox listener EPERM; approved rerun: 101 passed | `/tmp/torplay-review-current-integration.log`, `/tmp/torplay-review-current-integration-approved.log` |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox listener EPERM; approved rerun: 14 passed | `/tmp/torplay-review-current-surrounding.log`, `/tmp/torplay-review-current-surrounding-approved.log` |
| `npm run lint` | Passed | `/tmp/torplay-review-current-lint.log` |
| `npm run build --ignore-scripts` | Passed; generated-icon prebuild omitted | `/tmp/torplay-review-current-build.log` |
| `git diff --check` | Passed before documentation updates and rechecked afterward | — |

Regex reproductions ran separately from the unchanged suites. Passing existing
tests do not resolve the new execution-isolation defect.

### Publication and limitations

Only this report and the new Reviewer task were written. No production or test
changes, task cleanup, actual staging, branch change, commit, push, issue closure,
merge or deployment occurred. Unrelated changes remain intact.

The planned fresh isolated publication snapshot and exact staged-commit checks
are deferred at the new blocker. Earlier isolated snapshot results below are
historical supporting evidence, not current approval. Inspected the latest
independent Test report's fresh isolated real-browser evidence; this Review did
not repeat browser interactions. No live providers, external solver, full
external definition corpus or live acquisition/playback were exercised.

Next: `develop docs/tasks/reviewer/sources-search--bound-cardigann-regex-execution.md`,
then fresh complete Test and final Review.

## Historical Review before credential/Cookie correction

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Issue: [#145](https://github.com/jovev961/torplay/issues/145), verified open.
Starting/current branch: `develop`.

**CHANGES REQUIRED.** The Cardigann private download resolver can send a configured
source Authorization header to an unrelated initial destination supplied in a
search result. The existing redirect guard does not cover this first request.
The finding was reproduced through the generic engine and guarded HTTP transport
using synthetic settings and mocked DNS/HTTP. No live credentials were used.

Corrective task:
`docs/tasks/reviewer/sources-search--bind-download-credentials-to-source-origin.md`.
It records exact reproduction, affected code, requirements and acceptance criteria.

## Review basis and inspection

Expected behavior came from the primary task, its 25 acceptance criteria and
AGENTS.md. Reviewed the new configuration, family adapters, Cardigann interpreter
and transport, community imports, normalized contract, relevance, discovery,
private results, generic network/persistence changes, migrated API/UI consumers,
acquisition inspection, Debrid and Usenet boundaries, documentation, independent
replacement tests and the remaining corrective tasks. Compared relevant old code
and consumer contracts; developer reports were supporting evidence, not authority.

The replacement has one active runtime, source-neutral relevance, typed temporary
private results, and clearly separated acquisition inspection. The retained
upstream v11 schema is data. Inspection did not establish historical clean-room
provenance conclusively; similar protocol operations alone do not prove copying.
Passing tests and the simpler ownership model do not resolve the credential finding.

The earlier multi-episode finding is behaviorally resolved: all 105 Sources tests,
including explicit three-/four-episode lists and rejection cases, pass. The earlier
complete-Test gate is also resolved in the full working tree: the latest independent
Test report records complete success, parent Tester tasks are absent, and current
final checks pass. The two existing Reviewer tasks remain because final Review
has not approved the parent; their historical failure evidence is not a claim
that those defects still reproduce.

## Current full-working-tree checks

| Exact command | Result |
| --- | --- |
| `node --test tests/sources-*.test.js` | 105 passed, no skips/failures |
| `npm run test:unit` | 493 passed, no skips/failures |
| `npm run test:integration` | Sandbox listener EPERM; approved rerun: 101 passed |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox listener EPERM; approved rerun: 14 passed |
| `npm run lint` | Passed |
| `npm run build --ignore-scripts` | Passed; generated-icon prebuild omitted |
| `git diff --check` | Passed |

Logs: `/tmp/torplay-final-review-sources.log`,
`/tmp/torplay-final-review-unit.log`,
`/tmp/torplay-final-review-integration-approved.log`,
`/tmp/torplay-final-review-surrounding-approved.log`,
`/tmp/torplay-final-review-lint.log`, and
`/tmp/torplay-final-review-build.log`.

## Publication isolation and limits

The working tree includes unrelated Watch Together, playback, translation and
workflow edits. Built a temporary snapshot from HEAD plus the proposed Sources
changes, excluding those unrelated edits; no actual repository staging, branch
change or commit occurred. The scoped snapshot passes 479 unit tests, 95 integration
tests, lint and the default production build. Lower counts reflect excluded
unrelated test changes. Initial isolated build setup failed because Turbopack does
not allow a node_modules symlink outside its root; copying the existing installed
dependency snapshot resolved that harness limitation without changing app code.
Logs use `/tmp/torplay-final-review-isolated-{unit,integration,lint,build}.log`.

The isolated check is supporting evidence, not an approved commit. Publication and
Reviewer-task cleanup stop at the new security finding. Issue #145 remains open.
No merge, deployment or release occurred. Only this report and the new corrective
task were added by Review; production, tests and unrelated changes remain intact.

Existing synthetic-browser onboarding evidence was inspected; browser verification
was not repeated in this Review. No live providers, solver or complete external
definition corpus were exercised. Remaining final approval and exact staged-commit
verification must run again after correction and fresh independent Test.
