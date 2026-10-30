# Template E2E continued-snapshot diagnosis

Task: `425b3d9e-5eb6-42c2-b531-77e03e69c206`; parent: `b381ae1e-29b4-42f2-b2cd-381e20c18c65`, revision 3. Operator evidence, 2026-10-30; independent acceptance remains required.

## Cause and bounded repair

The retained parent's continued workspace has a 226-character absolute root. Pi's `getDefaultSessionDir` encodes the entire runtime fixture cwd into **one directory component**, exceeding the filesystem's 255-byte NAME_MAX. All 25 scenarios fail before `onSessionCreated`; the old catch concealed the startup error as empty tools/prompts.

Diagnostic stack: `ENAMETOOLONG: name too long, mkdir .../sessions/--Users-chris-...-test-fixtures-.runtime-...--`, Pi session-manager.ts:599 → SessionManager.create:1756 → runAgent:1140 → runScenario. Dependencies were lock-ready. This is neither a correction/renderer regression nor a timeout.

The test now sets `PI_CODING_AGENT_SESSION_DIR` to `join(hermeticDir, "sessions")`, restoring its prior value (including absence) during teardown. Real persisted sessions and repository-local runtime fixtures remain enabled; all 26 tests, tool/prompt assertions and timeouts are unchanged. Startup errors are rethrown; only errors after session capture remain tolerated for the faux provider. No production code or user/Pi configuration is changed. GitNexus query/impact was attempted but this snapshot is unindexed; direct call-site/runner inspection substituted.

## Reproduction and validation

Read parent's retained 16:02:52 transcript and continued source before design. Copied its tracked/unignored source files read-only into child `.diagnosis/parent-continued-combined`, excluding private `.pi`/vault state. Added only the startup-error diagnostic to the copied template test. At a 216-character root all 26 pass. Renamed the directory with suffix `-012345678` (226-character root): 25 failed, 1 passed, exact ENAMETOOLONG stack above. Parent artifacts were never modified.

Applied the short-session-root repair to this composition, retaining all parent correction, renderer and provenance sources. Installed isolated dependencies using authorized `npm ci --ignore-scripts --no-audit --no-fund`; used empty test-only git history. A preliminary symlinked dependency setup failed npm-ls preflight (npm interpreted linked transitive packages as development roots); replaced the link with its own clean install, without changing lock/config.

Operator results:
- Combined-source preflight, typecheck, lint (223 files), build: passed.
- Same 226-character combined-source template run: **26 passed**, 1.95s.
- First combined full run: **2809 passed, 1 failed, 7 skipped**. The failure was the parent's separate `kanban-controller` correction test: `Correction requires a recorded failed command and a different passing replacement`. Its two timestamp-based records can share a millisecond; no repair/filter applied in this task. A second full attempt timed out at 120s; no lingering process remained. These attempts are retained in worker transcript, not erased or classified as command corrections.
- Subsequent complete combined-source verbose run: **143 files passed, 2810 passed, 7 existing skips**, 41.29s. No filtered assertions or edits between attempts.
- Child baseline plus repair: preflight/typecheck/lint/build passed; full regression **142 files passed, 2794 passed, 7 existing skips**, 39.44s.
- Byte comparison of 291 composition/parent files after validation: only `test/ext-templates-e2e.test.ts` differs. `git diff --check` passes.

For local independent inspection the composition/logs were moved under the child `node_modules/.diagnosis/parent-continued-combined-012345678` so they cannot pollute source integration or root test discovery. The saved `template-before-long.log` and `full-after.log` retain the original 226-character run paths. This is disposable evidence, not a deliverable or a dependency on the parent workspace. Moving it makes its path longer; the repaired template suite should still pass. Run `npm test -- test/ext-templates-e2e.test.ts --maxWorkers=1` and `npm test -- --maxWorkers=4` from that directory for independent combined-source validation; do not modify retained parent files. Fresh tester snapshots may recreate a child-local composition from retained parent sources and overlay only this repaired test; prepare dependencies only under retained installation authorization. Ensure the reproduction root is at least 226 characters and initialize only empty test history if needed.

## Parent recovery (explicit, not automatic)

After this child has fresh independent tester/reviewer/orchestrator acceptance and conflict-checked Done, the orchestrator can explicitly continue parent `b381ae1e-29b4-42f2-b2cd-381e20c18c65` using ordinary accepted-dependency integration/ready. Import only this repair's test and documentation; preserve the parent's correction/renderer/provenance changes and all earlier evidence. Do not replace the live package, restart automatically, reset the revision or edit board/manifest JSON.

In the newly continued parent snapshot, use authorized isolated dependency preparation if needed, run `npm run snapshot:preflight`, typecheck/lint/build, the complete template file, correction/controller/renderer/provenance suites, then full regression with `--maxWorkers=4`. Require fresh independent evidence/scores; this document does not accept the parent. If the separate correction test timestamp failure recurs, retain its diagnostic and route it to that parent's implementation owner; a later passing run is not authorization to erase genuine failed evidence. Never use invalid-command correction for these assertion/product failures.
