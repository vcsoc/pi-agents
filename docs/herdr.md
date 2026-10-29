# Herdr compatibility

## Current support boundary

Pi-agents executes child agents through native Pi SDK sessions inside the parent
process. Those sessions do not own terminal panes. Kanban web visibility does not
change this execution model or prevent direct agent/workflow execution.

The locally inspected Herdr API exposes these supported reporting operations:

- `pane.report_agent`: requires `pane_id`, `source`, `agent`, and `state`.
- `pane.report_agent_session`: requires `pane_id`, `source`, and `agent`.
- `pane.report_metadata`: requires `pane_id` and `source`; annotates that pane.
- `pane.release_agent`: requires `pane_id`, `source`, and `agent`.
- `agent.view.set`: filters/sorts existing entries; it does not register children.

No independent, non-pane child-registration or named-group operation was found
in the exposed CLI help/schema. Reusing an inherited `HERDR_PANE_ID` for every
child would update the parent pane's agent, not create independent children.
Pi-agents deliberately does not perform that misleading registration. Parent
metadata is also not equivalent to separate grouped child entries.

The installed Herdr Pi integration inspected on this machine excludes non-TUI
sessions. Consequently its ordinary parent-pane integration does not register
these SDK children automatically.

## Verified environment

Read-only discovery used `herdr --skill`, CLI help, `herdr status`,
`herdr integration status`, `herdr api schema --json`, and local socket
`ping`, `agent.get`, and `agent.list` requests. No panes or agents were created,
updated, or removed during discovery.

On the inspected machine, CLI 0.9.1 advertises protocol 22 while the running
server 0.8.2 advertises protocol 20. Ordinary CLI agent introspection reports a
protocol mismatch. Newer CLI schema entries therefore do not prove that the
running server accepts those operations. Aligning CLI/server versions is a
separate host operation; it has not been performed by this extension. A version
alignment alone does not establish non-pane child support.

## Required host capability

Automatic individual entries and grouping require a verified Herdr interface
that accepts independent child identities and links them to their originating
parent session/run without claiming the parent's terminal pane. That interface
must support lifecycle updates, resume without duplicate entries, and cleanup
or expiry after shutdown/disconnection. Exact transport methods and grouping
fields must come from a supported Herdr contract, not invented endpoints.

A future adapter should use stable child IDs, truthful display names, and
minimal parent/session/run linkage. It must not transmit prompts, thoughts,
credentials, private transcripts, or the full environment. Host absence,
incompatibility, or transport failures must remain bounded and nonblocking for
native execution. Queued, running, resumed, finished, failed and aborted children
must be tested, including workflow and nested children and separate parent
sessions. Actual panel entries and grouping require real-host validation;
mock IPC success is insufficient.

This extension runs in Pi. A common Herdr protocol could also serve adapters in
Codex, Claude Code, or OpenCode, but installing or changing those harnesses or
Herdr itself is separate work and is not claimed here.
