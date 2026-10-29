# Project Kanban

The native Pi harness is always the operational home for pi-agents. Kanban is an optional external live view and task-control interface, off by default; it is not a replacement execution mode. Agent calls, workflows, ordinary tools, results, steering and the fleet remain available with the web interface on or off.

## Enable And Open

1. Open `/agents`, choose Settings, and turn Kanban on.
2. Run `/agents kban`. Pi opens a browser and also prints the private URL.
3. Ask the main agent to break your request into scopes, assign each task, define its acceptance rubric, and release the work.

You can also set `"kanbanEnabled": true` in project or personal `subagents.json` and reload Pi. The setting controls only access to the web interface. Enabling it never stops native agents; disabling it closes the local server without cancelling work, revoking task bindings, replacing sessions, hiding task tools or resetting evidence. Re-enabling displays the same harness task service, without duplicate dispatch. A trusted project is required for task-service activation.

The `Kanban` task tool is registered before an agent turn in trusted projects regardless of the web setting. The main agent can use it alongside ordinary tools, Agent and workflows. `/agents tasks` lists tasks and retained native runs without a browser. `/agents tasks pause <run-id>` explicitly stops one current native run, and `/agents tasks pause-all` pauses pending tasks, stops the local scheduler and cancels current native agents/workflows. These are deliberate cancellation controls, not effects of toggling the view. Paused task evidence is invalidated; existing native agent conversations can be explicitly resumed with Agent, and stopped workflows can be explicitly resumed through SubagentWorkflow. No automatic replay is promised.

Live Harness Runs shows the actual retained top-level agent/workflow records in this Pi session, including ordinary non-task work. Task planning/history is durable and project-shared; native run visibility is session-local and completed native records have the fleet's normal retention limit. Native runs are not fabricated into task-certified Done cards. Managed task workers still enforce their assigned capabilities and independent evidence gates.

## Task Lifecycle

| Column | Purpose |
| --- | --- |
| backlog | Capture scope, acceptance criteria, agent assignment, and rubric. No worker executes the task. |
| ready | Approved for its assigned operator to start or resume. |
| in progress | The operator implements the assigned scope. |
| review | The tester runs commands and scores the submitted revision; the reviewer independently reviews and scores it; the orchestrator performs final scoring. |
| done | Accepted work passed every completion gate, or obsolete work was explicitly closed with a `cancelled` disposition (not acceptance). Accepted tasks can receive read-only replies; cancelled tasks never dispatch. |

The orchestrator creates tasks using `Kanban create`, providing title, scope, assignee, and rubric criteria. Each criterion has a descriptive title and a positive percentage weight; weights must total 100. `testerAgent` and `reviewerAgent` default to `operate`. These are independent worker sessions with separate role-bound capabilities, even when they use the same agent definition/model. Use `inspect` or `design` as operators for read-only scopes, and `operate` for implementation and executable testing.

Each new task starts in backlog. `Kanban ready` releases it. The task-specific `KanbanTask` tool is injected into its worker, including isolated workers, and no worker may edit other tasks or delegate around the board. An operator calls `handoff` to submit work to testing. The tester calls `test` for actual commands, then `evaluate` with one 0-100 score per criterion, completes any required PR initiation, and hands off. The reviewer evaluates independently, performs its PR stage when required, and hands off to the orchestrator. The orchestrator uses `Kanban evaluate` and `Kanban complete`.

The following all block completion:

- Missing, below-85%, or outdated orchestrator, tester, or reviewer scores. Exactly 85% passes; percentages are not rounded up for gating.
- Missing passing test evidence, a failing latest execution of a recorded command, or a source snapshot different from the submitted revision.
- Incomplete configured PR review/merge or failure to publish all three evaluations to the PR.
- A paused, archived, reassigned, stale, or otherwise invalid task run.

A tester can give a below-threshold evaluation after a failed test; it must include precise repair instructions. The evaluation and test output remain in task history, a clear comment is added, current scores are invalidated, and the operator receives the task in ready. Reviewer or orchestrator rejection follows the same repair cycle.

Tests execute with a ten-minute command timeout and record command, exit code, bounded output, timestamp, and source fingerprint. Repeating the same command replaces its current result while preserving prior runs in history. Tests that modify source must be followed by resubmission and fresh testing, not certification of a different revision. Source fingerprints exclude private Pi/vault state, dependencies, and generated dist/coverage output. This verifies what was executed against which source snapshot; agents are still responsible for choosing meaningful tests and honestly evaluating the rubric. A successful `true` command is not a substitute for project-specific acceptance tests.

## Explicit Cancellation Without Acceptance

Use the orchestrator's `Kanban` tool with `action: "cancel"`, the task `id`, and non-empty `notes` explaining why the scope is obsolete. The authenticated user API also supports `POST /api/action` with `action: "cancel"`, `id`, `reason`, and the current `expectedUpdatedAt`. These controls work on unfinished, unarchived tasks; a successful accepted completion cannot be relabelled as cancellation. Task content or comments saying "cancel" do not authorize a worker to do so. Only the user or harness orchestrator can invoke this action; worker-bound `KanbanTask` has no cancellation capability.

Cancellation moves the card directly to Done and persists `disposition: { kind: "cancelled", reason, actor, at }`, plus a `cancelled without acceptance` audit event recording its previous column, phase, revision and revoked lease. It does not call `evaluate` or `complete`, invent scores, mark tests passing, integrate source, publish a PR, or certify acceptance. Existing evaluations and failed/passing tests remain exactly as recorded, with all comments, history, fingerprints, PR metadata, snapshots, private worktrees/checkpoints and run budgets retained. Legacy Done tasks without this disposition still use the existing accepted-completion semantics; the virtual demo board remains separate and read-only.

The action revokes the worker's tool capability immediately and requests abortion of its local native run. Other Pi sessions reconcile the revoked lease on their next tick; later tool calls fail closed. Execution-drain leases remain until the original worker actually settles (or its process is confirmed dead), so cancellation or subsequent archiving cannot prematurely free cross-process capacity. No filesystem edits or remote side effects are undone, and detached external processes cannot be guaranteed to terminate.

Cancelled tasks are terminal: comments remain available as history but never spawn read-only replies, and Backlog/Ready cannot reopen or reset their retained evidence. Create a new scoped task to authorize new work. Repeating cancellation retains the original reason and audit record rather than rewriting it. Cancelled Done cards can be archived normally without deleting their disposition or evidence. Pausing in Backlog remains the distinct, resumable edit/rework path and still invalidates current acceptance evidence. Cancellation is an honest closure outcome, never a substitute for managed-task acceptance or permission to weaken its gates.

## User Controls

- Add task submits a title, scope, operator and project-specific acceptance criterion to Backlog and notifies the harness orchestrator. It does not start work or accept forged scores. The orchestrator reviews/refines assignments and weighted criteria before release.
- Live Harness Runs shows native status, with Pause run for active agents/workflows. Pause all work pauses pending managed tasks (including in other Pi sessions sharing this board) and stops current native agents/workflows and scheduling in this Pi session. It does not control unrelated native runs in other Pi processes. Resume deliberately through the harness or individual task Ready controls.
- Click a card to open the complete task modal, including comments, independent evaluations, test results, PR link, and audit history.
- Add a comment to steer the currently running assigned worker. It is retained for subsequent roles. Idle completed tasks can dispatch a read-only response from the assigned agent; a comment alone never authorizes implementation changes.
- Drag a task to backlog or choose Pause in backlog to invalidate its active run and evidence. Edit its title, scope, assignment, and rubric, then save. Release to ready after editing. An orchestrator cannot silently release a task you paused.
- Only backlog and ready accept manual column changes. Dragging straight to review/done cannot bypass testing or scoring.
- Archive is available only for Done tasks, from the context menu or modal. It retains history and prevents future task/comment-response dispatch. For unfinished work, pause in Backlog to edit/resume later, or explicitly cancel obsolete scope through the harness tool/user API to close it as Done without acceptance. None of these actions undo filesystem edits, commits or PRs.
- Archive completed scope becomes available when every non-archived task is done. Show archive makes historical tasks visible again. Comments can document cancellation, but never resume archived work.
- Approve PR merge is available only for merge-policy tasks. It grants that task's reviewer permission to attempt the merge after passing gates. Scope changes/rework invalidate previous merge approval.

Closing a browser tab or disabling Kanban does not stop workers. Moving unfinished work to backlog or explicitly pausing runs requests cancellation; actual session shutdown still stops workers and releases resources. Cancellation blocks later managed-task tool calls and requests abortion of in-flight work; it cannot undo already-performed filesystem/network effects or guarantee termination of independently detached external processes.

## PR Policies And Git

The orchestrator chooses `prMode` from the user's request and repository instructions:

| Mode | Required behavior |
| --- | --- |
| none | Work in private source snapshots with conflict-checked integration; no GitHub operations. |
| review | Tester creates/pushes a PR and records tests/scores; reviewer publishes a review and verifies required CI. Leave merge to the user/project process. |
| merge | Same testing/review steps, plus explicit user merge approval and a verified completed merge before done. |

PR tasks require a Git repository with an initial commit, an `origin` remote pointing to the intended writable repository, and authenticated `gh`. Task worktrees start from committed HEAD: existing tracked project changes must be committed first, and untracked files are not copied. Subfolder projects retain their relative location inside the task worktree. The task gets a persistent external Git worktree on `pi-kban/<task-id>`; operator, tester, and reviewer share that task worktree. The operator must commit its changes on that branch and leave it clean before submitting. The tester pushes the branch, opens or updates its PR, and includes the task scope, weighted rubric, test evidence, and tester score. The reviewer checks required CI, publishes its independent review, and performs the configured PR stage. The final PR body is updated with all three scores before the task becomes done.

Agents normally share the same GitHub credential. The reviewer posts a comment review identifying its role; the extension does not pretend that this is an approval from a second GitHub account. Required human approvals and other branch protections still apply. Merge uses the expected head commit, never `--admin`, and is considered complete only after GitHub reports `MERGED`. Authentication, permission, missing required-check configuration, head changes, pending approvals, or merge failures stay visible instead of being marked done. A reviewer waiting for merge permission pauses; approving from the board allows the PR stage to resume.

PR worktrees and task branches are retained for inspection/rework; archiving does not automatically remove them. In review-only mode, done means the requested PR/testing/review scope is complete, not that the branch has merged into the original checkout. Even after a remote merge, the original local checkout is not automatically pulled.

Non-PR managed tasks run in private source snapshots, subject to the configured native background pool and cross-Pi leases. Tests and all three evaluations must certify the same source fingerprint. Completion serializes integration and refuses changed caller baselines (even disjoint changes), dirty/untracked caller paths (including staged edits masked by working-tree bytes equal to HEAD), private collisions and changed submissions; resubmit/retest instead of overwriting. Git branch/index are preserved. Recovery journals and original/displaced inodes may remain in private sibling directories even after success; inspect the reported recovery path and clean up only after editors release their descriptors. This is trusted-process isolation and synchronous failure recovery, not an OS sandbox or crash/power-loss-durable multi-file transaction. Writable same-filesystem sibling storage is required. Pausing retains snapshot evidence and does not revert edits. PR tasks use separate worktrees under the same native capacity constraints. Direct Agent/workflow work remains supported; it is not implicitly managed-task-certified and its caller-source changes can correctly cause a pending task integration conflict.

## Persistence, Budgets And Failure Recovery

The board name is the canonical project folder's basename. Its ID is the SHA-256 hash of the canonical absolute folder path, so symlinked paths share a board and equally named folders in different locations do not. Moving a folder changes its ID; boards are machine/path-specific rather than a cross-machine sync service.

State lives at `<Pi agent directory>/kanban/<project hash>/board.json`, outside the project and Git history. Writes use an exclusive process lock and atomic replacement. Task comments, transitions, tests, score evaluations, archive records, and failure reasons remain in history. Source revisions and role-bound run tokens reject stale workers. Different Pi sessions share the same durable state and cannot claim the same live task twice.

Default limits are 12 worker runs per task and 40 turns per worker run. The orchestrator may set `maxRuns` between 3 and 100 at creation. These runs incur normal provider costs; there is no implied monetary cap. Automatic repair attempts consume the same run budget. An exhausted budget is visible and blocks more runs until you move the task through backlog then ready to authorize a new budget. Orchestrator requeues do not reset a used budget. Test command output is truncated to the last 16,000 characters in current evidence; complete command output should be preserved separately when required by the project.

A worker that ends without a valid handoff becomes blocked rather than silently retrying. Read its transcript and task evidence before retrying through backlog/ready. Session shutdown marks interrupted work blocked; restarting Pi does not blindly replay a half-finished command. A lease from a process that no longer exists can be recovered. Corrupt state is reported, not silently reset. Back up the state directory for long-term history retention.

## Web And Trust Boundary

The server binds only to `127.0.0.1` on a random available port. Board APIs and the live SSE stream require a random bearer token, supplied in the browser URL fragment and retained only in that browser session. Requests with unexpected Host/Origin headers are rejected; API mutations require JSON, a matching task version, and bounded payloads. The frontend uses no third-party scripts/assets, renders task data as text rather than HTML, and reconnects its live stream after interruptions. Keep the private board URL private.

Kanban gates govern cooperative agent sessions in this extension. They are not operating-system sandboxes, GitHub authorization boundaries, or protection against arbitrary trusted extensions or a malicious process with filesystem access. In particular, a full-tool operator/tester still runs with your local permissions. Use repository review, normal GitHub protections, and external sandboxing where stronger isolation is required.

## Validation Commands

Run `npm run check` for lint/typechecking/unit and integration tests. On a heavily loaded machine, `npm test -- --maxWorkers=4` avoids contention with the existing workflow metadata evaluation time limit.

`npm run test:kanban:ui` builds and drives a real local Chromium through its debugging protocol, exercising live updates, desktop/mobile rendering, modal edits, comments, drag/drop, and archive controls. Install Chromium or set `CHROMIUM_BIN` to a compatible Chrome/Chromium executable. Set `KANBAN_UI_ARTIFACTS` to choose the screenshot directory; otherwise it uses a temporary directory. The fixture never releases real model work or creates a real GitHub PR. PR integration tests use local Git worktrees and simulated GitHub responses.
