## Complete-parent verification including regex isolation — 2026-10-02 (latest)

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Branch: `develop`. **Complete parent Test stage: PASSED.** This section supersedes
older Test results for the current working tree. No Review approval is claimed.

### Independent coverage and changes

Expected behavior was derived from the original task's requirements and all 25
acceptance criteria, using the recorded requirement matrix before inspecting
execution details. Added `tests/sources-regex-isolation.test.js`: nine subprocess
scenarios for hostile extraction, replacement, rendered filter patterns, template
patterns/inputs, source deadlines, caller cancellation, ordinary filter/template
behavior, event-loop responsiveness, healthy-source survival, safe diagnostics
and cleanup. Every child has an external eight-second SIGKILL watchdog. Children
exit naturally without process.exit, detecting workers that remain alive.
Only DNS and HTTP sockets are mocked; actual discovery and Cardigann run.

Existing independent replacement suites and valid credential/relevance/consumer
regressions remain unchanged. No further old tests were removed: the prior Test
stage already removed the 13 obsolete subsystem-owned suites. No production code
was changed. Updated only the independent plan/report and new regression suite.

### Commands and current results

Logs use `/tmp/torplay-test-20261002-<suffix>.log`.

| Command | Result | Log suffix |
| --- | --- | --- |
| `node --test tests/sources-regex-isolation.test.js` | 9 passed, no failures/cancellations/skips | regex |
| `node --test tests/sources-*.test.js` | 153 passed, no failures/cancellations/skips | sources |
| `npm run test:unit` | 541 passed, no failures/cancellations/skips | unit |
| `npm run test:integration` | Sandbox listener EPERM failures; permitted rerun 101 passed | integration, integration-approved |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox listener EPERM failure; permitted rerun 14 passed | surrounding, surrounding-approved |
| `npm run lint` | Passed | lint |
| `npm run build --ignore-scripts` | Passed; avoids prebuild mutation of tracked icons | build |
| `git diff --check` | Passed before final report; rerun afterward | — |

### Fresh native-browser verification

Started `node /tmp/torplay-sources-browser-server.mjs` with permitted loopback
binding on `127.0.0.1:3107`, the current production build and isolated storage
`/tmp/torplay-sources-browser-pYR6hJ`. The test harness was inspected before use;
DNS/HTTP were synthetic and outbound external fetches blocked. Browser-tab
connector was unavailable, so native Chrome was controlled using computer use
in a new tab. Created a disposable local profile.

- Fresh onboarding presented optional native integrations and Skip. Settings
  showed no sources configured.
- Custom Indexer Test connection displayed Connected without saving. Filesystem
  inventory confirmed no source configuration file had been created.
- Saved the custom source with Enabled unchecked; UI displayed DISABLED. Explicit
  Enable and Disable produced the corresponding states.
- Imported a compatible synthetic v11 definition referencing an unavailable
  endpoint and saved it disabled. UI displayed Supported and Complete separately
  from execution availability.
- Test displayed a safe source failure. A direct deep-equality assertion compared
  persisted configuration before/after, excluding verification metadata only;
  every other field and the unrelated custom source remained unchanged.
- Removed both disposable sources through the UI; it returned to No sources
  configured yet. A filesystem assertion confirmed zero persisted providers.
- Stopped the server cleanly; it recorded six synthetic source requests.

### Construction corrections and integrity

Initial newly written cancellation fixtures scheduled abort at 100 ms, after the
regex processing budget had already settled search. Changed the fixture to abort
at 10 ms to exercise an in-flight operation; the required AbortError expectation
was retained. Ordinary sibling results initially shared the same infohash and
were validly deduplicated; assigned a distinct healthy fixture hash. An initial
replacement hash accidentally contained 42 characters and was correctly rejected;
corrected it to a valid 40-character hash. The ordinary-template fixture also
needed an already-valid release title because it applies replacement to request
input, not the response title. These are fixture/contract mistakes, not relaxed
production expectations. Hostile boundedness/isolation assertions were retained.

### Workflow and limitations

No defects or new Tester corrective tasks were found. No Tester tasks exist for
this parent at completion, so none were removed. All four Reviewer tasks remain
unchanged for final Review; historical wording in their gate task is not current
Test status. Unrelated Watch Together/playback changes were preserved. No stage,
commit, push, issue closure, merge or deployment occurred.

Live providers, a live solver, the full external definition corpus and external
acquisition/playback were not exercised. Synthetic generic behavior does not
establish universal live availability. Architectural simplicity and historical
clean-room provenance remain independent Review decisions. All executable parent
Test checks completed; those external limits are explicitly recorded.

# Independent Sources/Search Test report

## Complete-parent verification after Cookie correction — 2026-10-01 (latest)

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Branch: `develop`. **Complete parent Test stage: PASSED.** This section supersedes
the credential-extension failure below. No Review approval is claimed.

Expected behavior was derived from the primary task and all 25 acceptance
criteria before inspecting existing assertions. The independent requirement
matrix remains applicable: configuration and migration; all source families;
opaque private resolution; security; concurrency, cancellation and diagnostics;
relevance, provenance and mirrors; configuration UI and consumer boundaries.
Historical results were not used as current pass evidence.

### Commands actually executed

| Command | Result | Log |
| --- | --- | --- |
| `node --test tests/sources-*.test.js` | 144 passed, no failures/cancellations/skips | `/tmp/torplay-sources-plan-preflight.log` |
| `node --test --test-name-pattern='Cardigann Cookie authenticated same-origin download and redirect remain usable' tests/sources-download-credentials.test.js` | Original failing regression: 1 passed unchanged | `/tmp/torplay-sources-recheck-cookie.log` |
| `node --test --test-name-pattern='provider-neutral relevance: punctuation and case\|provider-neutral relevance: multi-episode release\|explicit episode list\|movie and TV lookup forward original titles and episode context to discovery' tests/sources-results-relevance.test.js tests/sources-consumers.test.js` | 16 passed unchanged | `/tmp/torplay-sources-recheck-original-regressions.log` |
| `npm run test:unit` | 532 passed, no failures/cancellations/skips | `/tmp/torplay-sources-plan-current-unit.log` |
| `npm run test:integration` | Sandbox: 90 passed, 11 listener EPERM failures; approved rerun: 101 passed | `/tmp/torplay-sources-recheck-integration.log`, `/tmp/torplay-sources-recheck-integration-approved.log` |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox: 13 passed, 1 listener EPERM failure; approved rerun: 14 passed | `/tmp/torplay-sources-recheck-surrounding.log`, `/tmp/torplay-sources-recheck-surrounding-approved.log` |
| `npm run lint` | Passed | `/tmp/torplay-sources-recheck-lint.log` |
| `npm run build --ignore-scripts` | Passed; omitted prebuild icon-generation hook to preserve tracked assets | `/tmp/torplay-sources-recheck-build.log` |
| `git diff --check` | Passed before and after report/cleanup | — |

### Fresh real-browser verification

Executed `node /tmp/torplay-sources-browser-server.mjs` with approved loopback
binding at `127.0.0.1:3107`, the current production build, and isolated storage
`/tmp/torplay-sources-browser-ECqJVs`. Native Chrome was controlled through the
computer-use tool in a new tab. Source DNS/HTTP used synthetic fixtures; external
fetches were blocked. A disposable profile was created in the temporary database.

- Fresh onboarding offered optional native sources and Skip; Settings displayed
  zero configured sources. No native/custom source configuration files existed.
- Custom Indexer Test connection reported Connected without saving; filesystem
  inventory confirmed no source file was created. Save with Enabled unchecked
  produced a disabled record. Explicit Enable and Disable updated the UI.
- A schema-valid Cardigann v11 definition imported and saved disabled despite
  its unavailable endpoint. Compatibility and configuration remained Supported
  and Complete; Test reported a safe execution failure.
- Repeated failed verification preserved every persisted source configuration
  field, including the unrelated Custom Indexer, after excluding the expected
  verification metadata. A direct deep-equality assertion passed.
- UI removal of both disposable records restored No sources configured yet.
  A filesystem assertion confirmed zero custom records and no native source file.
- The test server was stopped cleanly; it recorded 7 synthetic source requests.

### Scope, cleanup and limitations

No production code or tests were changed. No new tests were needed: the existing
independent replacement suite includes all 39 credential cases and the original
corrective regressions. No additional old tests were removed; the earlier stage
already replaced the 13 obsolete Sources-owned suites. Runtime import inspection
and passing boundary checks found no obsolete Sources imports; retained API route
names are consumer contracts, not old implementation dependencies.

Removed only `docs/tasks/tester/sources-search--preserve-definition-download-cookies.md`
after the unchanged regression and complete parent verification passed. All three
Reviewer corrective tasks remain for independent final Review. No new defects or
corrective tasks were created. Unrelated working-tree changes were preserved.

Live providers, a live FlareSolverr service, the full external definition corpus,
and end-to-end external acquisition/playback were not exercised. Synthetic tests
establish the required generic behavior and guarded boundaries, not universal
live endpoint availability. Architectural simplicity and final publication remain
Review responsibilities. No commit, push, issue closure, merge or deployment.

## Credential-boundary verification extension — 2026-10-01 (latest)

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Branch: `develop`. **Complete parent Test stage: FAILED.** This latest result
supersedes the historical PASSED status below: expanded independent coverage
exposes a valid production defect. No Review approval is claimed.

The primary task and its 25 acceptance criteria remain the authority. The
requirement matrix was read and reconciled before adding tests. Existing
replacement coverage and original corrective assertions were retained unchanged.
The Reviewer credential-origin finding supplied a concrete additional attack
scenario, not a replacement specification. Current production origin checks
prevent its cross-origin leak, but authenticated same-origin Cookie downloads
do not preserve definition-configured credentials.

### Tests and defect

Added `tests/sources-download-credentials.test.js`: 39 independent synthetic
cases through discovery, public opaque selection, private resolution and the
real generic guarded transport. Only DNS/HTTP sockets are mocked. Coverage:
Authorization (both tested casing variants), Cookie, API-key and token headers;
initial destinations, selectors, preparation paths/path selectors, redirects,
HTTP rejection, credential-free cross-origin downloads and cookie-jar behavior.
Public result projections and safe failure diagnostics are checked for leaks.

38 new cases pass. The valid failing case is:
`Cardigann Cookie authenticated same-origin download and redirect remain usable`.
Both same-origin HTTPS download requests receive an empty Cookie header because
the transport's cookie-jar callback overwrites the configured header. The
assertion reports only header preservation failure, without secret values.
Server-set cookie-jar authentication and other tested headers pass. Created:
`docs/tasks/tester/sources-search--preserve-definition-download-cookies.md`.
The failure remains in the suite. No production correction was made.

### Exact commands and results

Each command below was executed in this stage. Full-suite commands were repeated
after the last test addition; counts reflect the final suite. Logs are local
artifacts, and filenames shared by earlier historical runs now contain these
latest results.

| Command | Result | Log |
| --- | --- | --- |
| `node --test tests/sources-download-credentials.test.js` | Construction run: 37 passed, 1 valid cookie failure after fixture corrections; final added jar case included in full suites | `/tmp/torplay-sources-download-test.log` |
| `node --test --test-name-pattern='Cardigann Cookie authenticated same-origin download and redirect remain usable' tests/sources-download-credentials.test.js` | Original cookie failure reproduced independently | `/tmp/torplay-sources-final-cookie-regression.log` |
| `node --test tests/sources-*.test.js` | 143 passed, 1 failed, no skips (144 total); all original 105 still pass | `/tmp/torplay-sources-final-focused.log` |
| `node --test --test-name-pattern='provider-neutral relevance: punctuation and case\|provider-neutral relevance: multi-episode release\|explicit episode list\|movie and TV lookup forward original titles and episode context to discovery' tests/sources-results-relevance.test.js tests/sources-consumers.test.js` | 16 passed unchanged | `/tmp/torplay-sources-final-original-regressions.log` |
| `npm run test:unit` | 531 passed, 1 failed, no skips (532 total); same cookie defect only | `/tmp/torplay-sources-final-unit.log` |
| `npm run test:integration` | Sandbox: 90 passed, 11 local-listener EPERM failures; approved rerun: 101 passed, no failures/skips | `/tmp/torplay-sources-final-integration.log`, `/tmp/torplay-sources-final-integration-approved.log` |
| `npm run lint` | Passed | `/tmp/torplay-sources-final-lint.log` |
| `npm run build --ignore-scripts` | Passed; inspected and omitted prebuild icon-writing/deletion hook | `/tmp/torplay-sources-final-build.log` |
| `git diff --check` | Passed | — |

### Fixture corrections, scope and limits

Initial construction assertions incorrectly compared header arrays with scalar
strings and treated an empty Cookie header as credential-bearing. Corrected
these fixture expectations because HTTP permits repeated values and an empty
header carries no credential. Used valid `session=value` syntax for Cookie.
The separate same-origin authentication assertion remains strict and failing;
it was not weakened to accommodate dropped cookies. No valid existing assertions
were changed, skipped or deleted.

No additional old tests were removed: the earlier independent stage already
removed the 13 obsolete subsystem-owned suites and created replacement coverage.
This stage changes only the new test, independent plan/report, and focused Tester
task. No Tester tasks existed at entry; none were removed. Reviewer tasks remain
untouched for final Review. Unrelated working-tree changes are preserved.

Earlier browser onboarding evidence is retained as historical evidence and was
not rerun in this credential-focused extension. No live provider, live solver or
full external definition corpus was exercised. Synthetic v11 tests do not imply
universal definition compatibility. Architectural simplicity and historical
clean-room provenance require independent final Review. Those limitations and
the retained valid cookie failure prevent a complete-parent success claim.

Next: `develop docs/tasks/tester/sources-search--preserve-definition-download-cookies.md`,
then fresh Test reruns the unchanged failure and complete parent verification.
No production changes, commit, push, issue closure, merge or deployment occurred.

## Complete-parent Test verification — 2026-10-01

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Branch: `develop`. **Complete parent Test stage: PASSED.** This section supersedes
the unsuccessful historical runs below. No independent Review approval is claimed.

Expectations were derived from the primary task before inspecting replacement
assertions. The existing independent requirement matrix was reconciled against
all 25 acceptance criteria. Its eight replacement suites cover configuration and
migration, native/Torznab/generic Cardigann execution, explicit optional solver
transport, public candidate privacy and private expiring IDs, provider isolation
and cancellation, relevance/provenance, mirrors, network security, diagnostics,
consumer contracts, and obsolete-runtime/documentation boundaries. Existing unit
and integration suites cover surrounding acquisition, next-episode and Usenet
contracts. Architectural simplicity and historical clean-room provenance remain
subjects for final independent Review rather than behavioral-test guarantees.

### Current commands and results

| Exact command | Result | Local log |
| --- | --- | --- |
| `node --test tests/sources-*.test.js` | 105 passed; no failures or skips | `/tmp/torplay-sources-plan-focused.log` |
| `node --test --test-name-pattern='provider-neutral relevance: punctuation and case\|provider-neutral relevance: multi-episode release\|movie and TV lookup forward original titles and episode context to discovery' tests/sources-results-relevance.test.js tests/sources-consumers.test.js` | All 3 original regressions passed unchanged | `/tmp/torplay-sources-complete-regressions.log` |
| `npm run test:unit` | 493 passed; no failures or skips | `/tmp/torplay-sources-plan-unit.log` |
| `npm run test:integration` | Sandbox local listeners failed with EPERM; approved rerun passed all 101 | `/tmp/torplay-sources-plan-integration.log`, `/tmp/torplay-sources-plan-integration-approved.log` |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox local listener failed with EPERM; approved rerun passed all 14 | `/tmp/torplay-sources-complete-surrounding.log`, `/tmp/torplay-sources-complete-surrounding-approved.log` |
| `npm run lint` | Passed | `/tmp/torplay-sources-plan-lint.log` |
| `npm run build --ignore-scripts` | Passed; icon-generation prebuild omitted | `/tmp/torplay-sources-plan-build.log` |
| `git diff --check` | Passed, including final report/task cleanup | — |

The previously reported duplicate translation-key failure does not reproduce in
the current working tree. No production correction or test weakening was made by
this Test stage. The checks bearing `plan` in their log names were executed during
the immediately preceding read-only planning turn against this same implementation.

### Repeated real-browser verification

Started `node /tmp/torplay-sources-browser-server.mjs` with approved local-listener
access. The production build ran at `http://127.0.0.1:3107` with isolated settings
and database storage in `/tmp/torplay-sources-browser-7RCvCV`. Native Chrome was
controlled through the computer-use tool; browser-tab connector control was
unavailable, so the native application was used. All provider HTTP/DNS responses
were synthetic and external Fetch traffic was blocked. No live credentials or
production settings were used.

Verified:

- Fresh onboarding offered optional integrations, explicit add actions and Skip;
  source configuration files were absent, with zero sources configured.
- Custom source Enabled defaulted unchecked. Test connection showed Connected
  with movie/TV capabilities without creating configuration files.
- Save without enablement displayed Disabled. Explicit Enable displayed Verified;
  Disable retained the configured source and displayed Disabled.
- A compatible synthetic Cardigann definition imported and saved with an
  unavailable search endpoint. Enabled defaulted unchecked; Settings separately
  displayed Supported, Complete and Disabled.
- Explicit enablement displayed Unavailable. Failed Test preserved enabled state,
  compatibility and completeness; the unrelated custom source remained disabled.
- Removal of both disposable sources returned Settings to No sources configured
  yet. A filesystem assertion confirmed an empty persisted custom list and zero
  native records. The temporary server was stopped after verification.

### Changes, cleanup and limits

This completion stage updates this report and removes only the three resolved
Tester tasks for this parent: dotted-release relevance, multi-episode relevance,
and TV original-title forwarding. Their original regression tests remain
unchanged. Three-/four-episode explicit-list coverage also passes. No new test
files were needed, no additional old tests were removed, and no new defect or
corrective task was identified. The earlier report below records the original
13 removed subsystem suites and eight independently created replacement suites.
Reviewer tasks remain for final Review; unrelated changes are preserved.

No live provider credentials, full external definition corpus, or live solver
were exercised. Synthetic v11 coverage does not guarantee every external
definition works; unsupported definitions are an allowed explicit state. Internal
redirect handling inside an external solver is not observable here. Browser
checks cover onboarding/configuration, not end-to-end live playback. Final
architecture assessment and publication scope belong to Review.

**No production changes, test assertion changes, commit, push, issue closure,
merge, deployment or Review approval were performed.**

## Complete-parent verification attempt — 2026-10-01

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Branch: `develop`. Expected behavior was derived from the primary requirements
and acceptance criteria before reading replacement test assertions. The existing
requirement matrix and independently created replacement suites were retained;
the old Sources-owned tests had already been removed during the earlier Test
stage. Rebuilding these independent suites again would discard valid regressions.

**Sources verification: PASS. Complete parent Test stage: NOT PASSED**, because
the repository unit check still fails the unrelated duplicate Macedonian
translation-key test. No new Sources defect or corrective task was found.
No production code, original regression assertion, Reviewer task, commit, issue
state or publication state was changed by this verification.

### Changes made by this Test session

- Added 13 requirement-driven cases to `tests/sources-results-relevance.test.js`:
  every explicitly listed episode in three- and four-episode releases, dotted
  titles, nonconsecutive lists, absent episodes, and wrong seasons. No implicit
  episode-range expectation was introduced.
- Updated the independent plan and this report. No new repository test files
  were created and no additional old tests were removed.
- Preserved all three original Tester regressions unchanged. They now pass.
- The Reviewer multi-episode finding is covered by the new tests, including the
  previously rejected third episode. Its task remains for independent Review.
- All three Tester task files remain: their regressions pass, but cleanup requires
  a successful complete parent Test stage. Tasks belonging to other parents were
  not changed.

### Exact check commands and current results

All log paths below are local `/tmp/` artifacts. They contain synthetic fixtures,
not live source credentials.

| Command | Result | Log |
| --- | --- | --- |
| `node --test --test-name-pattern='provider-neutral relevance: punctuation and case\|provider-neutral relevance: multi-episode release\|movie and TV lookup forward original titles and episode context to discovery' tests/sources-results-relevance.test.js tests/sources-consumers.test.js` | 3 passed unchanged | `/tmp/torplay-sources-final-original-regressions.log` |
| `node --test tests/sources-*.test.js` | 105 passed, no failures/cancellations/skips | `/tmp/torplay-sources-final-focused.log` |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/season-pack.integration.test.js` | Sandbox run failed with local-listener EPERM; approved rerun passed all 14 | `/tmp/torplay-sources-final-surrounding.log`, `/tmp/torplay-sources-final-surrounding-approved.log` |
| `npm run test:unit` | 492 passed, 1 failed out of 493 | `/tmp/torplay-sources-final-unit.log` |
| `npm run test:integration` | Sandbox run failed with local-listener EPERM; approved rerun passed all 101 | `/tmp/torplay-sources-final-integration.log`, `/tmp/torplay-sources-final-integration-approved.log` |
| `npm run lint` | Passed | `/tmp/torplay-sources-final-lint.log` |
| `npm run build --ignore-scripts` | Passed; prebuild icon generation omitted | `/tmp/torplay-sources-final-build.log` |
| `git diff --check` | Passed | No log required |

The failing unit test is `Macedonian messages do not silently overwrite duplicate
keys` in `tests/i18n.test.js` (assertion at line 18). It reports duplicate keys in
the current Macedonian messages file. This existing unrelated failure was not
weakened, fixed, or assigned to the Sources parent.

### Real browser onboarding verification

Ran `node /tmp/torplay-sources-browser-server.mjs` with approved local-listener
access. This temporary test-only launcher served the production build on
`http://127.0.0.1:3107` using temporary settings and database storage under
`/tmp/torplay-sources-browser-Z2YdCZ`. All source HTTP/DNS operations used synthetic
fixtures; external Fetch traffic was blocked. The required metadata setting used
a synthetic value. No production settings or credentials were used or changed.
Browser interactions used native Chrome through the computer-use tool.

Verified these user-visible and persisted behaviors:

1. Source onboarding offered optional integrations, explicit add actions and
   Skip for now; source configuration files were absent on the fresh runtime.
2. Custom Torznab Enabled defaulted to unchecked. Test connection displayed
   Connected with movie/TV capabilities without creating source configuration.
3. Saving without enabling displayed the custom source as Disabled in Settings.
4. Enable displayed Verified; Disable preserved the configured source as Disabled.
5. Importing a compatible synthetic Cardigann definition succeeded despite its
   search endpoint being unavailable. Enabled defaulted to unchecked; saving
   displayed Supported, Complete and Disabled as separate concepts.
6. Explicitly enabling that definition displayed Unavailable. A failed Test kept
   it enabled, compatible and configured, while the unrelated custom source stayed
   disabled and intact.
7. Removal confirmations removed only the selected disposable source. Removing
   both returned Settings to No sources configured yet. A filesystem assertion
   verified the persisted custom list was empty and no native source was saved.

The initial temporary launcher installed its DNS fixture before binding the local
server, which redirected the bind address. The fixture was moved after local bind;
this was harness setup, not a production finding. An initial final-state assertion
incorrectly expected an empty native file to exist; the fresh runtime correctly
has no native file. The assertion was corrected to treat ENOENT as zero native
records. No repository test assertion was changed to obtain a passing result.

The temporary server was stopped after verification. Browser checks establish
onboarding and configuration behavior; they do not establish live source content
availability or end-to-end playback.

### Coverage and remaining limits

The eight Sources suites cover the complete recorded requirement matrix: source
configuration/migration; native, Torznab and synthetic v11 Cardigann execution;
explicit solver transport; candidate normalization and private IDs/resolution;
concurrency, isolation, cancellation and diagnostics; relevance and provenance;
mirror failover; network/redirect/size/deadline security; HTTP/UI/Usenet/acquisition
consumer boundaries; obsolete-import and documentation checks. Surrounding suites
exercise Debrid handoff, real season-pack acquisition, next-episode behavior and
the repository's other consumer regressions. Browser checks close the previously
unexecuted onboarding interaction scenarios.

No live source credentials, full external Cardigann corpus, or live solver were
used. Synthetic v11 coverage does not prove every external definition works;
unsupported definitions remain an explicit allowed state. External solver internal
redirect handling is not directly observable here. Historical clean-room provenance
and final architectural simplicity require independent Review; static ownership
checks passed. End-to-end live acquisition/playback is outside these browser checks.

**No production fixes or publication performed. Complete parent Test stage remains
not passed; corrective task cleanup and Review approval were not claimed.**

Earlier reports below are historical; current results above supersede their
test counts and onboarding coverage limitation.

## Corrective-task retest — 2026-10-01

Request: test all three tasks in `docs/tasks/tester/`.
Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.

All three original regression tests pass unchanged: dotted release punctuation
and case, explicitly included multi-episode releases, and movie/TV original-title
forwarding with episode context. Expectations were checked against product
requirement 6 and acceptance criteria 15 and 21 before implementation inspection.
The existing independent requirement matrix and replacement suites were reused;
this corrective retest did not remove or create tests, or modify production code.

| Exact command | Current result |
| --- | --- |
| `node --test --test-name-pattern='provider-neutral relevance: punctuation and case' tests/sources-results-relevance.test.js` | 1 passed |
| `node --test --test-name-pattern='provider-neutral relevance: multi-episode release' tests/sources-results-relevance.test.js` | 1 passed |
| `node --test --test-name-pattern='movie and TV lookup forward original titles and episode context to discovery' tests/sources-consumers.test.js` | 1 passed |
| `node --test tests/sources-*.test.js > /tmp/torplay-sources-retest.log 2>&1` | 92 passed, no failures/cancellations/skips |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/sources-boundaries.test.js > /tmp/torplay-surrounding-retest.log 2>&1` | 17 passed |
| `npm run test:unit > /tmp/torplay-unit-retest.log 2>&1` | 479 passed, 1 failed out of 480 |
| `npm run test:integration > /tmp/torplay-integration-retest.log 2>&1` | Sandbox blocked local listeners with EPERM |
| `npm run test:integration > /tmp/torplay-integration-retest-approved.log 2>&1` | Authorized execution outside sandbox: 101 passed |
| `npm run lint > /tmp/torplay-lint-retest.log 2>&1` | Passed |
| `npm run build --ignore-scripts > /tmp/torplay-build-retest.log 2>&1` | Passed; prebuild icon generation omitted |
| `git diff --check` | Passed |

The sole unit failure remains `Macedonian messages do not silently overwrite
duplicate keys` in `tests/i18n.test.js:18`. It is unrelated to these corrective
tasks and was not fixed or assigned to the Sources parent. No new Sources
defects or corrective tasks were found in this retest.

**Requested corrective regressions: PASS. Complete parent Test stage: NOT
PASSED.** All three corrective task files remain because the complete parent
stage has not passed. The synthetic-provider, controlled-hook/SSR, external
solver and architectural verification limitations described below remain;
browser onboarding and live provider/corpus coverage were not added in this
retest. Only this report was edited. No publication or Review approval occurred.

The remainder of this report records the earlier independent Test stage and its
original failures; the current retest results above supersede those results.

Parent task: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`

Stage: Test mode. **FAIL — the complete parent Test stage has not passed.**

Branch: `develop`. The session began with substantial existing production,
documentation and unrelated test changes. This Test stage changed tests and Test
documentation only. No production fix, commit, push, issue closure or Review
approval was performed.

## Authority and coverage

The independent matrix was recorded in `sources-search-test-plan.md` before
replacement assertions were written. Expected behavior came from the primary
task and its acceptance criteria, not the development completion report or old
subsystem assertions.

The replacement suites exercise:

- Empty installation, optional integrations, explicit enable/disable/remove,
  configuration preservation/migration, invalid saved records, serialized writes,
  verification separated from configuration and compatibility.
- Native, Torznab and generic synthetic v11 HTML/JSON/XML Cardigann execution;
  login/settings, community import, revision pinning and metadata-only discovery.
- Concurrent isolated provider failures, deadlines, pre/mid-flight cancellation,
  progressive reader cancellation, stable IDs and late-rejection handling.
- Public candidate privacy, sanitized diagnostics/logs, opaque expiring IDs,
  kind checks, validated magnets/binary metadata and private NZB resolution.
- Movie/episode relevance, aliases, international titles, similar-prefix
  rejection, optional metadata, deterministic rank/deduplication and provenance.
- Conservative current-mirror failover, exclusion of legacy links, direct versus
  explicitly required solver transport, solver endpoint/final-target validation.
- Generic network destination/DNS policy, redirects, credential forwarding,
  pinned DNS, response/decompression bounds and whole-operation deadlines.
- Search/Settings HTTP contracts, torrent inspection, Debrid fixture integration,
  Usenet isolation/resolution, original-title forwarding and source UI rendering.
- Runtime stale-import and subsystem-ownership checks; native-provider exceptions
  absent from generic Cardigann; no individual Tested Source names added to the
  inspected general documentation changes.

## Defects and corrective developer tasks

| Finding | Failing boundary | Corrective task |
| --- | --- | --- |
| Dot-separated release words are concatenated, rejecting a valid punctuation/case match | `provider-neutral relevance: punctuation and case` | `docs/tasks/tester/sources-search--dotted-release-relevance.md` |
| A release explicitly containing the requested episode is rejected | `provider-neutral relevance: multi-episode release` | `docs/tasks/tester/sources-search--multi-episode-relevance.md` |
| TV lookup omits the supplied original title from its discovery request | `movie and TV lookup forward original titles and episode context to discovery` | `docs/tasks/tester/sources-search--tv-original-title-forwarding.md` |

All three valid failing tests remain unchanged after classification. The task
files include exact focused reproduction commands and validity explanations.
They are present locally; the repository ignores `docs/tasks/` in Git. No Tester
tasks were removed because the complete parent stage has not passed.

The full unit suite also fails the existing test `Macedonian messages do not
silently overwrite duplicate keys` in `tests/i18n.test.js`. It reports duplicate
translation keys in the current messages file. This is outside the Sources task;
it was reported, not fixed or turned into a corrective task for this parent.

## Files changed by Test

Removed 13 old Sources-owned suites, without porting their assertions:

```text
tests/cardigann.test.js
tests/community-directory.test.js
tests/custom-providers.test.js
tests/flaresolverr.test.js
tests/jackett-service.test.js
tests/legacy-jackett-migration.test.js
tests/native-sources.test.js
tests/search-progressive.test.js
tests/search-provider.test.js
tests/search-route.test.js
tests/search-service.test.js
tests/source-panel-render.test.js
tests/streamable.test.js
```

The old streamable suite belonged to the removed Sources implementation. The
new consumer suite independently tests the required acquisition handoff and
file-suitability boundary under its new owner.

Created eight suites and one fixture helper:

```text
tests/sources-boundaries.test.js
tests/sources-cardigann.test.js
tests/sources-configuration.test.js
tests/sources-consumers.test.js
tests/sources-discovery.test.js
tests/sources-network.test.js
tests/sources-protocols.test.js
tests/sources-results-relevance.test.js
tests/helpers/sources-fixtures.js
```

Preserved the existing assertions in `tests/source-availability.test.js` and
`tests/debrid-routes.test.js`; only private-result fixture setup/imports were
migrated to the current normalized store. Preserved the existing assertions in
`tests/settings-validation.test.js`; its response fixture now intercepts the
guarded HTTP/DNS transport used by the Sources adapter, rather than assuming
that adapter still consumes the old injected Fetch transport.

Also created the independent plan, this report and the three corrective tasks.
Other pre-existing test/production changes were left intact.

## Commands and results

Final verification commands were:

| Exact command | Result |
| --- | --- |
| `node --test tests/sources-*.test.js > /tmp/torplay-sources-focused.log 2>&1` | 92 tests: 89 pass, 3 fail, 0 cancelled/skipped |
| `node --test tests/settings-validation.test.js tests/source-availability.test.js tests/debrid-routes.test.js tests/sources-boundaries.test.js > /tmp/torplay-sources-surrounding.log 2>&1` | 17 tests pass |
| `npm run test:unit > /tmp/torplay-sources-unit.log 2>&1` | 480 tests: 476 pass, 4 fail, 0 cancelled/skipped |
| `npm run test:integration > /tmp/torplay-sources-integration.log 2>&1` | 101 tests pass after approved execution outside the sandbox |
| `npm run lint > /tmp/torplay-sources-lint.log 2>&1` | Pass |
| `npm run build --ignore-scripts > /tmp/torplay-sources-build.log 2>&1` | Pass; icon-generation prebuild hook deliberately not executed |
| `git diff --check` | Pass |

The preserved defects were also reproduced individually after the final suites:

```sh
node --test --test-name-pattern='provider-neutral relevance: punctuation and case|provider-neutral relevance: multi-episode release' tests/sources-results-relevance.test.js > /tmp/torplay-sources-relevance-regressions.log 2>&1
node --test --test-name-pattern='movie and TV lookup forward original titles and episode context to discovery' tests/sources-consumers.test.js > /tmp/torplay-sources-tv-regression.log 2>&1
```

Both relevance regressions and the TV request regression still fail.

Earlier construction runs executed the same focused/unit/lint commands and this
initial subset command:

```sh
node --test tests/sources-configuration.test.js tests/sources-discovery.test.js tests/sources-results-relevance.test.js tests/sources-cardigann.test.js tests/sources-network.test.js > /tmp/torplay-sources-focused.log 2>&1
```

The initial integration run failed because the sandbox prohibited local socket
listeners (`EPERM`). The same command was rerun with approved escalation and
passed. An early consumer-cancellation construction run and its unit run were
interrupted because the fixture reused a complete cache entry and waited for a
network request that should not occur on that cached path. The final cancellation
test explicitly refreshes and has a bounded test timeout.

## Test corrections made during construction

These corrections were based on fixture/contract errors, not attempts to match
an implementation defect:

- Synthetic definitions initially omitted v11-required category, size and
  seeders fields. Added those fixture fields after checking schema validation.
- A fictional filter is invalid under the schema, rather than a valid unsupported
  feature. Replaced that fixture with schema-valid certificate pinning to test
  compatibility separately from schema validity.
- Verification fixtures require compatibility metadata; added it to synthetic
  configured records. A network-unavailable scenario now throws a typed transport
  failure rather than an arbitrary JavaScript error.
- The fake socket now stops its response and reports a destroy error before
  permitting successful completion, matching the intended transport lifecycle.
- The first multi-episode fixture presumed that E02E04 implied episode 3. The
  primary task does not specify that range convention. Changed the fixture to
  S02E03E04, where the requested episode is explicitly present. This corrected
  test still fails and has not been weakened.
- Renamed a test loader variable to comply with the repository's Next lint rule.

## Limitations and remaining verification

- No live source credentials/endpoints were used. Synthetic definitions cover
  demonstrated generic HTML/JSON/XML/login/transport behavior, not every v11
  definition or every schema feature in an external corpus.
- UI checks use SSR and a controlled hook harness, not a full browser interaction
  session. They verify displayed provenance/diagnostics and actual request
  construction but do not establish all onboarding interaction behavior.
- Sources network tests use controlled DNS/socket fixtures; the separate
  integration suite exercises real local networking. External solver internal
  redirect behavior is not observable here; endpoint and final destination
  validation were tested.
- Architectural simplicity and historical clean-room provenance cannot be
  conclusively established by automated behavioral tests. Static ownership and
  obsolete-runtime-import checks passed; final architectural approval belongs
  to independent Review.
- The three reported defects must be fixed in Develop, then the unchanged
  regression tests and full parent verification must run again in fresh Test.
  Browser/manual and corpus coverage limitations must remain explicit; this
  report does not declare all acceptance criteria satisfied.

**Complete Test stage: failed. No production fixes or publication performed.**
