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
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestSchema = z.looseObject({
  experimental: z.looseObject({ monitors: z.unknown().optional() }).optional(),
  mcpServers: z.string(),
  monitors: z.unknown().optional(),
  name: z.string(),
  skills: z.string()
});
const mcpSchema = z.looseObject({
  mcpServers: z.record(
    z.string(),
    z.looseObject({
      args: z.array(z.string()),
      command: z.string(),
      cwd: z.string().optional()
    })
  )
});
const workspaceSchema = z.looseObject({
  catalog: z.looseObject({ husky: z.string() })
});
/**
 * @template {z.ZodType} S
 * @param {string} directory - Base directory.
 * @param {string} filename - JSON file.
 * @param {S} schema - Expected file shape.
 * @returns {Promise<z.infer<S>>} Parsed JSON data.
 */
const readJson = async (directory, filename, schema) => {
  /** @type {unknown} */
  const value = JSON.parse(
    await readFile(path.join(directory, filename), "utf-8")
  );
  return schema.parse(value);
};

await test("both hosts resolve the shared conventional skill and their own MCP configuration", async () => {
  const claude = await readJson(
    root,
    ".claude-plugin/plugin.json",
    manifestSchema
  );
  const codex = await readJson(
    root,
    ".codex-plugin/plugin.json",
    manifestSchema
  );
  assert.equal(claude.name, "codex-app-server");
  assert.equal(codex.name, claude.name);
  assert.equal(claude.skills, "./skills");
  assert.equal(codex.skills, claude.skills);
  const claudeMcp = await readJson(root, claude.mcpServers, mcpSchema);
  const codexMcp = await readJson(root, codex.mcpServers, mcpSchema);
  const packageJson = await readJson(
    root,
    "package.json",
    z.looseObject({
      devDependencies: z.looseObject({ husky: z.string() }),
      scripts: z.looseObject({ prepare: z.string() })
    })
  );
  const workspace = workspaceSchema.parse(
    yamlParser(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf-8"))
  );
  const claudeServer = claudeMcp.mcpServers[claude.name];
  const codexServer = codexMcp.mcpServers[codex.name];
  const huskyPackage = `--package=husky@${workspace.catalog.husky}`;
  /**
   * @param {string} packagePath - Package location.
   * @param {string} binary - Binary name.
   */
  const localPackageArgs = (packagePath, binary) => [
    "exec",
    "--yes",
    huskyPackage,
    "--",
    "npm",
    "exec",
    "--yes",
    "--install-links",
    `--package=${packagePath}`,
    "--",
    binary
  ];
  assert.equal(packageJson.devDependencies.husky, "catalog:");
  assert.equal(packageJson.scripts.prepare, "husky");
  assert.match(workspace.catalog.husky, /^\^\d+\.\d+\.\d+$/u);
  assert.equal(claudeServer.command, "npm");
  assert.deepEqual(
    claudeServer.args,
    localPackageArgs(`\${CLAUDE_PLUGIN_ROOT}`, "codex-app-server")
  );
  assert.equal(codexServer.command, "npm");
  assert.deepEqual(codexServer.args, localPackageArgs(".", "codex-app-server"));
  assert.equal(codexServer.cwd, "./");
  assert.ok(codexServer.args.every((argument) => !argument.includes("${")));
  for (const manifest of [claude, codex]) {
    assert.equal(manifest.monitors, undefined);
    assert.equal(manifest.experimental?.monitors, undefined);
  }
  await assert.rejects(readFile(path.join(root, "monitors/monitors.json")), {
    code: "ENOENT"
  });
});

await test("the installed-root skill retains valid metadata, conditional references, and its Monitor asset", async (t) => {
  const installed = await mkdtemp(path.join(tmpdir(), "codex-plugin-layout-"));
  t.after(async () => {
    await rm(installed, { force: true, recursive: true });
  });
  await cp(path.join(root, "skills"), path.join(installed, "skills"), {
    recursive: true
  });
  const directory = path.join(installed, "skills/thread-control");
  const skill = await readFile(path.join(directory, "SKILL.md"), "utf-8");
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
  assert.ok(match);
  const metadata = z
    .looseObject({
      description: z.string(),
      metadata: z.record(z.string(), z.string()).optional(),
      name: z.string()
    })
    .parse(yamlParser(match.groups.yaml));
  assert.equal(metadata.name, path.basename(directory));
  assert.ok(metadata.description.trim().length > 0);
  assert.ok(metadata.description.length <= 1024);
  assert.ok(
    Object.values(metadata.metadata ?? {}).every(
      (value) => typeof value === "string"
    )
  );
  await Promise.all(
    ["SKILL.md", "references/monitor.md", "references/lifecycle.md"].map(
      async (filename) => {
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
      }
    )
  );
  const setup = await readJson(
    directory,
    "assets/monitor.json",
    z.looseObject({
      command: z.string(),
      timeout_ms: z.number()
    })
  );
  assert.equal(setup.timeout_ms, 1_800_000);
  const workspace = workspaceSchema.parse(
    yamlParser(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf-8"))
  );
  const huskyPackage = `--package=husky@${workspace.catalog.husky}`;
  assert.ok(
    setup.command.includes(
      `npm exec --yes ${huskyPackage} -- npm exec --yes --install-links --package="\${CLAUDE_PLUGIN_ROOT}" -- codex-thread-monitor`
    )
  );
  assert.ok(setup.command.includes("--thread '*'"));
  assert.ok(setup.command.endsWith("--timeout-seconds 1800"));
});
