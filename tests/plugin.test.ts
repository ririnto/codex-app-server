import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { load as yamlParser } from "js-yaml";
import relativeLinksRule, {
  markdownIt
} from "markdownlint-rule-relative-links";
import { lint } from "markdownlint/promise";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestSchema = z.looseObject({
  mcpServers: z.string(),
  name: z.string(),
  skills: z.string()
});
const mcpSchema = z.looseObject({
  mcpServers: z.record(
    z.string(),
    z.looseObject({
      args: z.array(z.string()),
      command: z.string(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string())
    })
  )
});
const workspaceSchema = z.looseObject({
  catalog: z.looseObject({ husky: z.string() })
});
const readJson = async <S extends z.ZodType>(
  directory: string,
  filename: string,
  schema: S
): Promise<z.infer<S>> => {
  const value: unknown = JSON.parse(
    await readFile(path.join(directory, filename), "utf-8")
  );
  return schema.parse(value);
};

const probeScript =
  '#!/bin/sh\nread -r input\npwd -P\nprintf "%s\\n" "$0" "$input" "$@"\nprintf "fixture stderr\\n" >&2\nexit 23\n';

const launchPaths = async (t: TestContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex plugin path "));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const installed = path.join(directory, "installed");
  const runners = path.join(directory, "runners");
  await Promise.all([mkdir(installed), mkdir(runners)]);
  await Promise.all([
    ...["codex-app-server", "codex-thread-monitor", "run-p"].map(
      async (name) => {
        await writeFile(path.join(installed, name), probeScript, {
          mode: 0o755
        });
      }
    ),
    ...["npm", "pnpm"].map(async (name) => {
      await writeFile(path.join(runners, name), probeScript, { mode: 0o755 });
    }),
    writeFile(path.join(runners, "git"), "#!/bin/sh\nprintf 'AGENTS.md\\0'\n", {
      mode: 0o755
    })
  ]);
  return { directory, installed, runners };
};

await test("MCP and monitor launch commands preserve both installed and package execution", async (t) => {
  const { directory, installed, runners } = await launchPaths(t);
  const plugin = path.join(directory, "plugin root");
  await cp(path.join(root, "skills"), path.join(plugin, "skills"), {
    recursive: true
  });
  const workspace = workspaceSchema.parse(
    yamlParser(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf-8"))
  );
  const [claudeConfig, codexConfig, monitor, readme, skill] = await Promise.all(
    [
      readJson(root, ".mcp.json", mcpSchema),
      readJson(root, "mcp.json", mcpSchema),
      readJson(
        root,
        "skills/thread-control/assets/monitor.json",
        z.object({ command: z.string() })
      ),
      readFile(path.join(root, "README.md"), "utf-8"),
      readFile(
        path.join(root, "skills/thread-control/references/monitor.md"),
        "utf-8"
      )
    ]
  );
  const claude = claudeConfig.mcpServers["codex-app-server"];
  const codex = codexConfig.mcpServers["codex-app-server"];
  const shellExample =
    /^```sh\n(?<command>NODE_USE_SYSTEM_CA=1 [^\n]+)\n```$/gmu;
  const readmeExamples = [...readme.matchAll(shellExample)];
  const skillExamples = [...skill.matchAll(shellExample)];
  assert.equal(readmeExamples.length, 3);
  assert.equal(skillExamples.length, 1);
  const [claudeExample, codexExample, monitorExample] = readmeExamples;
  const [skillExample] = skillExamples;
  const monitorArgs = [
    "--thread",
    "*",
    "--status",
    "idle",
    "--status",
    "failed",
    "--status",
    "systemError",
    "--timeout-seconds",
    "1800"
  ];
  const cases = [
    ["Claude MCP", claude.command, claude.args, directory, plugin],
    [
      "Codex MCP",
      codex.command,
      codex.args,
      path.resolve(plugin, codex.cwd ?? ""),
      "."
    ],
    [
      "README Claude MCP",
      "/bin/sh",
      ["-c", claudeExample.groups?.command ?? ""],
      directory,
      plugin
    ],
    [
      "README Codex MCP",
      "/bin/sh",
      ["-c", codexExample.groups?.command ?? ""],
      plugin,
      "."
    ],
    [
      "Monitor input",
      "/bin/sh",
      ["-c", monitor.command],
      directory,
      plugin,
      monitorArgs
    ],
    [
      "Skill monitor",
      "/bin/sh",
      ["-c", skillExample.groups?.command ?? ""],
      directory,
      plugin,
      monitorArgs
    ],
    [
      "README monitor",
      "/bin/sh",
      ["-c", monitorExample.groups?.command ?? ""],
      plugin,
      ".",
      ["--thread", "AUTHORIZED_THREAD_ID", "--timeout-seconds", "300"]
    ]
  ] as const;
  await Promise.all(
    cases.map(async ([name, command, args, cwd, packagePath, toolArgs]) => {
      await t.test(name, async (testCase) => {
        const binary =
          toolArgs === undefined ? "codex-app-server" : "codex-thread-monitor";
        const expanded = args.map((arg) =>
          arg.replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, plugin)
        );
        await Promise.all(
          [false, true].map(async (useInstalled) => {
            await testCase.test(
              useInstalled ? "installed binary" : "package runner",
              async () => {
                const result = await execa(command, expanded, {
                  cwd,
                  env: {
                    ...claude.env,
                    PATH: useInstalled
                      ? [installed, runners].join(path.delimiter)
                      : runners
                  },
                  extendEnv: false,
                  input: "fixture input\n",
                  reject: false
                });
                assert.equal(result.exitCode, 23);
                assert.equal(result.stderr, "fixture stderr");
                assert.deepEqual(result.stdout.split("\n"), [
                  await realpath(cwd),
                  useInstalled
                    ? path.join(installed, binary)
                    : path.join(runners, "npm"),
                  "fixture input",
                  ...(useInstalled
                    ? []
                    : [
                        "exec",
                        "--yes",
                        `--package=husky@${workspace.catalog.husky}`,
                        "--",
                        "npm",
                        "exec",
                        "--yes",
                        "--install-links",
                        `--package=${packagePath}`,
                        "--",
                        binary
                      ]),
                  ...(toolArgs ?? [])
                ]);
              }
            );
          })
        );
      });
    })
  );
});

await test("staged checks prefer run-p on PATH and keep pnpm exec when absent", async (t) => {
  const { directory, installed, runners } = await launchPaths(t);
  await Promise.all(
    [false, true].map(async (useInstalled) => {
      await t.test(
        useInstalled ? "installed binary" : "package runner",
        async () => {
          const result = await execa(
            process.execPath,
            [path.join(root, ".husky/check-staged.ts")],
            {
              cwd: directory,
              env: {
                PATH: useInstalled
                  ? [installed, runners].join(path.delimiter)
                  : runners
              },
              extendEnv: false,
              input: "fixture input\n",
              reject: false
            }
          );
          assert.equal(result.exitCode, 1);
          assert.equal(result.stderr, "fixture stderr");
          assert.deepEqual(result.stdout.split("\n"), [
            "Running checks for staged paths: check:markdownlint-cli2, check:ultracite",
            await realpath(directory),
            useInstalled
              ? path.join(installed, "run-p")
              : path.join(runners, "pnpm"),
            "fixture input",
            ...(useInstalled ? [] : ["exec", "run-p"]),
            "check:markdownlint-cli2",
            "check:ultracite"
          ]);
        }
      );
    })
  );
});

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
  const claudeServer = claudeMcp.mcpServers[claude.name];
  const codexServer = codexMcp.mcpServers[codex.name];
  assert.deepEqual(claudeServer.env, { NODE_USE_SYSTEM_CA: "1" });
  assert.deepEqual(codexServer.env, claudeServer.env);
  assert.equal(codexServer.cwd, "./");
  assert.ok(codexServer.args.every((argument) => !argument.includes("${")));
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
  assert.ok(match.groups);
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
  assert.ok(setup.command.includes("--thread '*'"));
  assert.ok(setup.command.endsWith("--timeout-seconds 1800"));
});
