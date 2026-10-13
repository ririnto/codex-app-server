import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import yamlParser from "markdownlint-cli2/parsers/yaml";
import relativeLinksRule, {
  markdownIt
} from "markdownlint-rule-relative-links";
import { lint } from "markdownlint/promise";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (directory, filename) =>
  JSON.parse(await readFile(path.join(directory, filename), "utf-8"));

test("both hosts resolve the shared conventional skill and their own MCP configuration", async () => {
  const claude = await readJson(root, ".claude-plugin/plugin.json");
  const codex = await readJson(root, ".codex-plugin/plugin.json");
  assert.equal(claude.name, "codex-app-server");
  assert.equal(codex.name, claude.name);
  assert.equal(claude.skills, "./skills");
  assert.equal(codex.skills, claude.skills);
  const claudeMcp = await readJson(root, claude.mcpServers);
  const codexMcp = await readJson(root, codex.mcpServers);
  const claudeServer = claudeMcp.mcpServers[claude.name];
  const codexServer = codexMcp.mcpServers[codex.name];
  assert.equal(claudeServer.command, "npm");
  assert.ok(claudeServer.args.includes(`--package=\${CLAUDE_PLUGIN_ROOT}`));
  assert.equal(codexServer.command, "npm");
  assert.ok(codexServer.args.includes("--package=."));
  assert.equal(codexServer.cwd, "./");
  assert.ok(codexServer.args.every((argument) => !argument.includes("${")));
  const monitors = await readJson(root, claude.experimental.monitors);
  assert.equal(monitors[0].name, "codex-thread-status");
  assert.ok(
    monitors[0].command.endsWith("-- codex-thread-monitor --require-threads")
  );
  assert.ok(
    monitors.every(
      (monitor) => monitor.when !== undefined && monitor.when !== "always"
    )
  );
  assert.ok(monitors[0].when.startsWith("on-skill-invoke:"));
  const skillName = monitors[0].when.slice("on-skill-invoke:".length);
  const skill = await readFile(
    path.join(root, claude.skills, skillName, "SKILL.md"),
    "utf-8"
  );
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
  assert.equal(yamlParser(match.groups.yaml).name, skillName);
  assert.notEqual(skillName, "thread-control");
});

test("the installed-root skill retains valid metadata, conditional references, and its Monitor asset", async (t) => {
  const installed = await mkdtemp(path.join(tmpdir(), "codex-plugin-layout-"));
  t.after(() => rm(installed, { force: true, recursive: true }));
  await cp(path.join(root, "skills"), path.join(installed, "skills"), {
    recursive: true
  });
  const directory = path.join(installed, "skills/thread-control");
  const skill = await readFile(path.join(directory, "SKILL.md"), "utf-8");
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
  assert.ok(match);
  const metadata = yamlParser(match.groups.yaml);
  assert.equal(metadata.name, path.basename(directory));
  assert.ok(metadata.description.trim().length > 0);
  assert.ok(metadata.description.length <= 1024);
  assert.ok(
    Object.values(metadata.metadata ?? {}).every(
      (value) => typeof value === "string"
    )
  );
  await Promise.all(
    [
      "SKILL.md",
      "references/monitor.md",
      "references/lifecycle.md",
      "../thread-monitor/SKILL.md"
    ].map(async (filename) => {
      const source = path.join(directory, filename);
      const result = await lint({
        config: {
          default: false,
          "relative-links": { root_path: installed }
        },
        customRules: [relativeLinksRule],
        markdownItFactory: () => markdownIt,
        strings: { [source]: await readFile(source, "utf-8") }
      });
      assert.deepEqual(result[source], [], filename);
    })
  );
  const setup = await readJson(directory, "assets/monitor.json");
  assert.equal(setup.timeout_ms, 1_800_000);
  assert.ok(setup.command.includes("--thread '*'"));
  assert.ok(setup.command.endsWith("--timeout-seconds 1800"));
});
