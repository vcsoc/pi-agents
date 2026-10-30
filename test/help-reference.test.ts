import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const readme = source("../README.md");

describe("plain-language help reference", () => {
  it("explains every persistent setting in the settings table", () => {
    const settings = source("../src/settings.ts").match(/export interface SubagentsSettings \{([\s\S]*?)\n\}/)?.[1];
    expect(settings).toBeDefined();
    const keys = [...(settings ?? "").matchAll(/^ {2}(\w+)\?:/gm)].map(match => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    const table = readme.slice(readme.indexOf("## Persistent Settings"), readme.indexOf("## Events"));
    for (const key of keys) expect(table, `Missing explanation for ${key}`).toContain(`| \`${key}\` |`);
  });

  it("keeps provider-specific comparisons out of user guides and the help example", () => {
    for (const path of ["../README.md", "../docs/workflows.md", "../docs/packages.md", "../docs/rpc.md", "../examples/agent-tool-description.md"]) {
      expect(source(path), path).not.toMatch(/claude|anthropic|haiku|sonnet|opus/i);
    }
  });

  it("records fork copyright and imported source provenance", () => {
    const license = source("../LICENSE");
    expect(license).toContain("Copyright (c) 2026 vcsoc");
    expect(license).toContain("The above copyright notice and this permission notice shall be included");
    expect(source("../UPSTREAM.md")).toContain("ca93a5247e72e7053fcd10bea7125d6c4205f949");
    expect(source("../UPSTREAM.md")).toContain("see LICENSE");
  });

  it("documents Git installation and separates storage and sandbox limitations", () => {
    expect(readme).toContain("pi install https://github.com/vcsoc/pi-crew.git");
    expect(readme).toContain("sessions, `.output` logs, memory files, and worktree commits are separate");
    expect(readme).toContain("not operating-system sandboxes");
  });
});
