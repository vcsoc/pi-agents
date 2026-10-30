# Complete-source enumeration: activation handoff

## Scope and observed identity (2026-10-30)

Task `fd8bfeb7-3b11-43b4-8aad-96d59a424f6e` implements isolated source only.
No installed package, live session, settings, application or external board was changed.

- Installed checkout: `/Users/chris/.pi/agent/git/github.com/vcsoc/pi-agents`
- Observed installed HEAD: `e30ce5b`; installed and snapshot package versions: `0.1.4`.
- Installed `src/kanban/execution.ts` SHA256 (also the snapshot's original bytes):
  `ff1ff273a64d7611e86578b97e6af4a78350f1cef32ae5d38a3f5057c67bab8b`
- Candidate execution module SHA256:
  `be6deaaf615fce8df7e9df0a8a44f12d4e0d1f2c0822d80138364e503af65dc3`
- Candidate snapshot:
  `/Users/chris/.pi/agent/kanban/1b0d6fa4133f590e3e16100af508c995c30b14047fd2d3f03d35fd8a3056ef24/snapshot-fd8bfeb7-3b11-43b4-8aad-96d59a424f6e-1-5c820627-1142-4c7e-beef-b043e1d53e32`

The version deliberately does not change: `/crew version` alone cannot identify
this same-version source fix. Compare bytes as well as the loaded version.

## Transport contract

Ordinary `command` calls still retain only the last 64000 characters per stream.
Fingerprint enumeration requests `{ completeStdout: true }` through the existing
injected `Command` interface, including its controller rest-argument wrappers.
Complete stdout retains at most 16 MiB of raw bytes (the existing synchronous
source enumeration bound), decodes UTF-8 only after collection, and returns
`stdoutComplete: true`. Overflow kills the process group and rejects, rather
than returning a tail or triggering filesystem fallback. Stderr stays diagnostic.
Ten-minute timeout, abort handling and SIGTERM/SIGKILL escalation remain shared.

Custom runners must forward the fifth argument and only claim completeness when
they actually preserve all stdout. Legacy results without metadata retain the
old >=64000-character fail-closed guard; explicit incomplete results, oversized
byte counts, and missing final NULs are rejected. Small legacy fixtures remain
compatible. Nonzero Git exit retains the existing bounded filesystem fallback;
transport rejection and cancellation do not fall back. Hashing and private-path
exclusions are unchanged, as are all independent certification gates.

## Separately owned activation, only after acceptance and quiescence

The orchestrator/user must arrange the installed-package owner and safe idle
window. This worker must not apply or reload the live harness mid-run. Do not
create a recursive workaround task or automatically resume suspended ancestors.

1. Finish independent tester, reviewer and orchestrator acceptance (each >=85,
   same complete source fingerprint, passing recorded commands). Accept into the
   owning caller through normal conflict-checked snapshot integration. Preserve
   concurrent session-directory repairs and caller edits; if integration refuses
   its baseline, stop and reconcile through the existing owner, never force-copy.
2. Record `/crew version`, installed package path, `git status --short`, HEAD,
   package version and `shasum -a 256 src/kanban/execution.ts` in that installed
   checkout. Recheck the candidate module hash above against accepted source.
   Installed version must still be `0.1.4` and execution bytes must match the
   original hash above. Any changed execution bytes, version or unexpected
   checkout movement requires owner review/revalidation; do not overwrite it.
3. Allow active native/task/workflow runs to finish and drain naturally. Retain
   their board, snapshots, transcripts and session-directory repairs. If an idle
   window cannot be arranged, report activation pending; do not kill a session.
4. At that idle window, the installed owner creates a private, timestamped backup
   outside source enumeration (for example under installed `.pi/`), retaining the
   original execution file bytes and mode, installed HEAD/status, both hashes and
   accepted evidence. Verify the backup hash equals the original hash above.
   Do not copy the snapshot wholesale, touch other modules, rewrite settings,
   stage/commit changes or run package-manager update/install as an activation
   shortcut. The extension manifest loads TypeScript directly; dist is not the
   loaded entry point.
5. Stage only accepted execution module bytes in a temporary sibling file of the
   installed module, preserving its mode. Verify the staged hash, then recheck
   installed original hash/mode immediately before an atomic rename under the
   exclusive idle maintenance window. A conflict aborts publication, leaving the
   backup/candidate intact. Verify installed SHA256 equals the candidate above;
   record the exact one-file diff. This is cooperative maintenance, not an OS
   compare-and-swap guarantee against hostile concurrent writers.
6. The user invokes supported `/reload` from the idle main Pi session, never from
   an in-flight worker. Reload replaces session-bound extension state. Confirm
   `/crew version` and installed module hash, and run a read-only >64k enumeration
   smoke check verifying async `fingerprint` equals `sourceFingerprint` and that
   discarded-prefix mutation is detected in a disposable fixture. Use the tests
   in `test/kanban-execution.test.ts`; do not mutate retained parent/application
   source to smoke-test. If reload remains stale, request user exit and
   `pi --continue` from the original project; do not kill/restart it automatically
   or load a duplicate `-e` extension.
7. Rollback, if needed: first drain naturally again; require current installed
   hash to equal the candidate hash above. Stage the verified backup bytes/mode,
   recheck current candidate bytes, atomically restore only that module, verify
   original hash, then ask the user to `/reload` again. If installed bytes changed
   after activation, stop for owner reconciliation rather than overwriting them.

The cross-board relation `db2290f2` completed-before/blocking `f77bf1c8` (then
`300584ad`) remains unresolved. Installed activation and separately accepted
recovery must be established before an orchestrator explicitly considers those
retained tasks. Runtime completion here is neither activation nor parent recovery.

See the existing [Kanban lifecycle](kanban.md) for certification and integration
rules and the README for `/reload` / `/crew version` behavior.
