# pi-crew

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
