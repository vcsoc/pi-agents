# pi-crew

## 2026-10-30 Kanban Off Workflow Requirement
- User requires Kanban off to disable the entire Kanban process, not merely the web UI: no Kanban tools/tasks, board workflow, rubrics or managed acceptance orchestration in off mode.
- Off mode must manage agents directly through the native agents harness, report progress in clear human-readable language, and complete work efficiently without unnecessary handoffs. Enabled mode retains Kanban workflows.
- Implemented full off-mode gating in src/index.ts and src/kanban/controller.ts: no cold board initialization, exposed task tool/policy, stale orchestrator execution, new dispatch or board notifications. Native Agent tools remain available; direct-mode prompt requests concise human-readable progress and efficient work without task/rubric/handoff overhead.
- Existing workers retain capabilities/evidence for safe checkpoint drainage; follow-on roles wait until re-enabled. Idle disabled controllers do not read storage. Demo tool denial is now a native session guard without a synthetic Kanban binding; ordinary turn-limit messages no longer mention task handoffs.
- Validation after review fixes: 143 test files pass (2813 tests, 7 skipped; 43.11 seconds), including off/on/off, stale-call rejection, storage bypass, dispatch race, native-agent preservation and asynchronous evaluate/complete cancellation regressions. Typecheck, lint and dependency-free command check pass. Complete source extension loads through Pi's actual loader with zero errors; cold-off exposes native tools/direct policy and creates no Kanban storage.
- Independent review found unused run-budget consumption during interrupted preparation and in-flight orchestrator mutation after disabling. Fixed by atomically refunding the unused reservation with lease release (retained across board-lock contention retries and safe against duplicate refunds) and rechecking enabled state after asynchronous fingerprint/PR operations and before integration/evaluation writes. Existing worker checkpoint drainage remains permitted. GitNexus unavailable because checkout is unindexed; manual diff review used. Publication/update pending.

## 2026-10-30
- User renamed the project from pi-agents to pi-crew. Canonical extension command is `/crew`, with version, demo, tasks and kban subcommands; no legacy command alias is registered.
- Updated extension command guidance, workflow/board UI messages, README, current docs and command lookup tests. Generic Agent APIs, agent resource directories, settings, RPC events and compatibility identifiers remain unchanged.
- Expected origin: https://github.com/vcsoc/pi-crew.git. The isolated task snapshot had no origin; added and verified this URL locally. Source checkout remote is outside snapshot scope and still needs orchestrator verification.
- Reload Pi after applying the change. If the loaded version remains stale, restart with `pi --continue`.
- Snapshot dependency preflight fails (missing croner); installation is not authorized. Run `node scripts/check-crew-command.mjs` for dependency-free command branch coverage. Full Vitest regression validation requires authorized snapshot dependency preparation.
- GitNexus impact and API impact checks were requested but unavailable because the snapshot is not indexed. Independent acceptance is pending.

## 2026-10-30 Live Direct Application
- UPDATE: Applied the preserved 51-file rename diff and three new artifacts directly to the live checkout after exact snapshot-index baseline comparison and git apply --check; no conflicts. Original untracked .pi files are preserved.
- UPDATE: Live origin fetch/push URL is https://github.com/vcsoc/pi-crew.git.
- UPDATE: Live dependency validation passes: node scripts/check-crew-command.mjs, git diff --check, and 13 focused Vitest files (397 tests; 4.48 seconds). No dependency installation was needed.
- Live GitNexus impact attempt is unavailable because the checkout is not indexed. Direct evidence is not managed acceptance or task certification; no commits or pushes. Reload/restart remains a user action.

## 2026-10-30 17:08 UTC Publication Authorization
- User explicitly requires commit, then normal push to pi-crew.git, then documented Pi package update of the existing Git-installed extension. Do not replace the installed entry with a local source path.
- Sole direct live owner for d317bfcd-1964-49d5-8d9b-f7ecf2678b74 (parent de278f38-c652-43c8-ad30-085eebf29109); managed worker is paused. No delegation, parent restart, PR merge or managed certification is authorized.
- Live inspection: main tracks origin/main at 933f3e343287cc774e1b77394593ca893b9781ea; index empty; 51 intended tracked rename files plus command check and vault notes; unrelated untracked .pi is preserved.
- Focused revalidation: 13 Vitest files / 297 tests pass (4.60 seconds), dependency-free command check and git diff --check pass, npm run typecheck passes. Existing dependencies only.
- GitNexus detect_changes unavailable: live repository not indexed. Manual diff review confirms command/guidance rename and assertions only; compatibility identifiers remain intact. Both old and renamed Git URLs currently resolve to the same remote main commit.

## 2026-10-30 17:10 UTC Publication Outcome
- Committed intended rename, command check and vault notes as 3bd01189a4cff8dc64df5f6249f7f4f6159b9855 (feat: rename extension command to crew), 54 files / 258 insertions / 182 deletions. Staged diff passed whitespace/manual scope review; no unrelated .pi files were staged.
- Normal git push origin main succeeded (933f3e3..3bd0118). Remote main at both pi-crew.git and legacy pi-agents.git verified at the exact published SHA.
- After push, documented pi update https://github.com/vcsoc/pi-agents.git succeeded against the existing settings entry. Standard updater dependency preparation added two runtime packages, audit zero vulnerabilities. No settings substitution, local source install, snapshot install, force push, amend, merge or direct reset was performed.
- Actual installed checkout /Users/chris/.pi/agent/git/github.com/vcsoc/pi-agents has clean git status and HEAD 3bd01189a4cff8dc64df5f6249f7f4f6159b9855; legacy origin/settings entry is retained and follows the renamed remote.
- Fresh loadExtensions check using Pi loader imported the complete installed manifest entry src/index.ts with zero errors. Registered command list is exactly crew (no agents); version handler reports pi-crew v0.1.4 (loaded); all four native tools registered. No session lifecycle, agents or managed tasks were started.
- Current live session has not been reloaded; user can run /reload, then /crew version, or restart with pi --continue if needed. This is direct publication/update evidence, not managed acceptance or parent recovery.
- This outcome and matching index update are local post-publication memory changes; they are intentionally not a second source release.
