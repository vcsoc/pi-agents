# Upstream Attribution

pi-agents is a fork of pi-subagents.

- Imported version: 0.22.0
- Imported commit: ca93a5247e72e7053fcd10bea7125d6c4205f949
- Fork copyright: vcsoc, 2026.
- License: MIT; see LICENSE for the current notice.
- CHANGELOG.md preserves the upstream release history. Fork changes are recorded here.

## Fork Changes (0.1.0)

- Package name: pi-agents. No upstream author, repository, or issue tracker is presented as the fork's maintainer or destination.
- Creation wizard uses the current Pi model and offers configured registry models instead of hard-coded Claude tiers.
- All built-in agents inherit the parent Pi model/provider. inspect no longer requests Anthropic Haiku.
- Model labels treat every provider consistently, retaining the model's display name instead of stripping the Claude brand.
- Runtime diagnostics, temporary-output root, manager symbol, scope gate, and package-name matching use pi-agents.
- Development dependencies target Pi 1.4.0; existing >=1.1.0 host peer ranges are retained.
- Cross-provider regression tests cover OpenAI, Google, Ollama, and custom gateway IDs, including model IDs containing slashes.

## Retained Interfaces

The Agent, SubagentWorkflow, get_subagent_result, and steer_subagent tool names, /agents command, subagents:* events/RPC, pi.subagents package resources, subagents.json settings, and agent/workflow resource directories are retained. The alternate top-level package-resource declaration is pi-agents; prefer pi.subagents for portable packages. The manager registry is Symbol.for("pi-agents:manager").

Claude-style agent files, workflow scripts, badges, mention syntax, and tool conventions remain supported. None require the Claude CLI or an Anthropic provider. The preserved upstream reference documentation includes Claude examples and historical design notes; they do not constrain which provider runs an agent.

Do not enable this fork and upstream simultaneously: they register the same tool and command names. No automatic migration or changes to personal Pi settings are performed by this repository.
