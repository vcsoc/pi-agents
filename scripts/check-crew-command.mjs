import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the real registration block without importing the dependency-heavy extension.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('  pi.registerCommand("crew", {');
assert.notEqual(start, -1, 'Canonical command must be registered');
assert.doesNotMatch(source, /pi\.registerCommand\(["']agents["']/);
const end = source.indexOf('\n  });', start) + '\n  });'.length;
assert.ok(end > start);
const commands = new Map();
const notices = [];
let menus = 0;
const toggles = [];
const controller = {
  pauseAll: async () => {},
  pauseAgent: async () => {},
  view: () => ({ tasks: [], harnessRuns: [] }),
};
const sandbox = {
  pi: { registerCommand: (name, command) => commands.set(name, command) },
  EXTENSION_VERSION: 'test-version',
  crewStatus: () => `Crew status: ${sandbox.extensionEnabled ? 'on' : 'off'}`,
  extensionEnabled: true,
  kanbanEnabled: false,
  setExtensionEnabled: async enabled => { sandbox.extensionEnabled = enabled; toggles.push(enabled); },
  notifyApplied: (ctx, message) => ctx.ui.notify(message, 'info'),
  showAgentsMenu: async () => { menus++; },
  ensureKanban: () => controller,
};
runInNewContext(source.slice(start, end), sandbox);
assert.deepEqual([...commands.keys()], ['crew']);
const command = commands.get('crew');
assert.match(command.description, /\/crew version/);
const ctx = { ui: { notify: (...args) => notices.push(args) } };
await command.handler('  version  ', ctx);
assert.deepEqual(notices.pop(), ['pi-crew vtest-version (loaded)', 'info']);
await command.handler('', ctx);
assert.equal(menus, 1);
await command.handler('  on  ', ctx);
assert.equal(sandbox.extensionEnabled, true);
assert.equal(sandbox.kanbanEnabled, false);
assert.match(notices.pop()[0], /pi-crew enabled/);
await command.handler('off', ctx);
assert.equal(sandbox.extensionEnabled, false);
assert.equal(sandbox.kanbanEnabled, false);
assert.deepEqual(toggles, [true, false]);
assert.match(notices.pop()[0], /pi-crew disabled/);
await command.handler('  status  ', ctx);
assert.deepEqual(notices.pop(), ['Crew status: off', 'info']);
await command.handler('', ctx);
assert.match(notices.pop()[0], /pi-crew is off/);
assert.equal(menus, 1);
await command.handler('on', ctx);
notices.pop();
await command.handler('tasks', ctx);
assert.match(notices.pop()[0], /Kanban is off/);
await command.handler('kban', ctx);
assert.match(notices.pop()[0], /\/crew > Settings/);
sandbox.kanbanEnabled = true;
await command.handler('tasks', ctx);
assert.match(notices.pop()[0], /Kanban tasks/);
await command.handler('tasks invalid', ctx);
assert.match(notices.pop()[0], /Use \/crew tasks/);
console.log('PASS: /crew registration, no legacy command, help, loaded version, status while disabled, extension-wide on/off toggles independent of Kanban, menu, tasks, task usage, and disabled Kanban guidance');
