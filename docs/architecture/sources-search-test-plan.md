## Regex-isolation extension — 2026-10-02

Derived from parent requirements 5/9 and acceptance criteria 13/14 before
inspecting execution details: independently bound hostile filter extraction,
replacement, rendered patterns and template processing through discovery; check
healthy siblings, event-loop progress, cancellation, ordinary semantics, safe
public diagnostics and natural process exit. Every scenario has an external
8-second watchdog so synchronous stalls and lingering workers cannot hang Test.
Preserve existing independent suites and run the full requirement matrix,
surrounding/unit/integration/lint/build checks and isolated real-browser setup.
No production fixes or Reviewer task cleanup belongs to this stage.

# Independent Sources/Search test plan

## Credential-boundary extension — 2026-10-01

Requirements 4 and 9 and acceptance criteria 11/24 require source credentials to
remain private and scoped to the configured source. Independently exercise the
normal search → opaque candidate → private resolver path with synthetic v11
definitions and the real guarded transport, mocking only DNS and HTTP sockets.
Cover Authorization, Cookie, API-key and token headers at initial result URLs,
download selectors, preparation paths/path selectors, and redirects. Assert that
cross-origin and HTTP destinations receive no authenticated request, same-origin
authenticated downloads succeed, credential-free public downloads succeed, and
public candidates/diagnostics contain neither credentials nor private URLs.
Retain existing valid tests unchanged. This extends the completed historical
verification with coverage requested by the still-open Reviewer credential task.

Parent: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`

Authority: the primary task's product requirements and acceptance criteria;
neither the previous tests nor the development report define expectations.

## Requirement matrix recorded before replacement tests

| Acceptance criteria | Independent verification |
| --- | --- |
| 1, 2, 19, 20, 22, 25 | Runtime import/ownership audit: one Sources implementation, retained generic foundations, no obsolete dependencies or acquisition lifecycle ownership |
| 3, 4, 5 | Empty isolated installation; native/custom configure-enable-disable-remove; legacy representable configuration survives reads and writes; unrepresentable configuration is surfaced |
| 6, 7 | Synthetic v11 HTML/JSON/XML definitions, settings/login/templates; unsupported features versus missing configuration versus unavailable endpoint; unavailable compatible imports remain saveable |
| 8 | Explicit solver requirement, missing solver diagnostic, direct definitions never use solver, validated optional external solver transport |
| 9 | Generic Torznab capabilities, searches, authentication failures, malformed feeds, movie/episode/season-pack requests |
| 10, 15, 16 | Common public candidate shape across families; optional metadata; source/origin separation; deterministic deduplication/ranking; aliases, international/case/punctuation titles, similar-prefix false positives, episodes and packs |
| 11, 12, 24 | Opaque expiring stable result IDs, unknown/wrong-kind rejection, validated private resolution; no locators or credentials in public results, diagnostics, settings or captured logs |
| 13, 14, 18 | Concurrent provider execution, partial success, bounded failure diagnostics, no-results versus errors, deadlines, pre/mid-flight cancellation, no late updates or unhandled rejections |
| 17 | Current links as one logical source; connectivity-only conservative mirror failover; no legacy promotion; security on mirrors and redirects |
| 21 | Movie/TV consumers, torrent acquisition, Debrid availability, next episode, settings and Usenet external contracts preserved or explicit scoped follow-up |
| 23 | No newly introduced individual Tested Source names in general documentation or environment examples |
| Security product requirement | URL credentials/protocols, destination/DNS policies, redirects and credential forwarding, bounded body/decompression/deadlines, no open proxy |

## Execution rules

- Replace Sources-owned tests without copying or translating their assertions.
- Retain tests owned by other subsystems and preserve valid expectations.
- Use synthetic responses and isolated temporary settings/cache storage; no live source credentials.
- Keep correct failing assertions unchanged and create focused Tester corrective tasks.
- Do not modify production code or publish work.
- Run focused suites, surrounding regressions, unit/integration checks and lint.
- Report coverage gaps and environment limitations; incomplete verification is not a passed Test stage.

## Parent verification extension — 2026-10-01

The original requirement matrix remains the authority. Preserve the independently
created replacement suite and the three valid Tester regressions unchanged.
Extend TV release coverage to every explicitly listed episode in three- and
four-episode releases, dotted release names, nonconsecutive explicit lists,
absent episodes and contradictory seasons. Do not assume implicit ranges.

Exercise onboarding and Settings in a real browser against an isolated local
runtime: zero configured sources, test without saving, save disabled, explicit
enable/disable, import/save a compatible definition with an unavailable endpoint,
failed verification without configuration changes, and removal. Use temporary
configuration/database storage and synthetic endpoints; block outbound provider
traffic. Run Sources, unchanged corrective regressions, surrounding acquisition
checks, all unit/integration checks, lint, build and whitespace checks. Leave
Reviewer task resolution to Review and retain Tester tasks unless the complete
parent stage passes.
