import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

import { watchThreads } from "../lib/monitor.mjs";
import { createNativeSessions } from "../lib/native-session.mjs";
import { closeQueues, enqueueMessage } from "../lib/queue.mjs";
import { SessionTransport } from "../lib/session-transport.mjs";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const monitorPath = fileURLToPath(new URL("../monitor.mjs", import.meta.url));
const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

const CATALOG = {
  definitions: { Mode: { enum: ["a", "b", "#/definitions/literal"] } },
  oneOf: [
    {
      properties: {
        method: { enum: ["fs/readFile"] },
        params: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        }
      },
      required: ["method", "params"],
      type: "object"
    },
    {
      properties: {
        method: { enum: ["config/write"] },
        params: {
          properties: { mode: { $ref: "#/definitions/Mode" } },
          required: ["mode"],
          type: "object"
        }
      },
      required: ["method", "params"],
      type: "object"
    },
    {
      properties: {
        method: { enum: ["thread/delete"] },
        params: { type: "object" }
      }
    },
    {
      properties: {
        method: { enum: ["account/rateLimitResetCredit/consume"] }
      }
    },
    {
      properties: {
        method: { enum: ["thread/read"] },
        params: { type: "object" }
      }
    }
  ]
};

/**
 * Run the real stdio MCP server against a disposable Unix WebSocket fixture.
 */
const fixture = async (context, handler, options = {}) => {
  const directory = await mkdtemp("/tmp/sinon-mcp-");
  const socket = path.join(directory, "socket space-\u03A9?#:.sock");
  const http = createServer();
  const wsServer = new WebSocketServer({ server: http });
  const requests = [];
  const connections = new Set();
  wsServer.on("connection", (ws) => {
    connections.add(ws);
    ws.on("error", () => {});
    ws.on("close", () => connections.delete(ws));
    ws.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (!message.id) {
        return;
      }
      requests.push(message);
      const reply = (result) =>
        ws.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize" && !options.failInitialize) {
        reply({});
      } else {
        handler({ connections, message, reply, ws });
      }
    });
  });
  http.listen(socket);
  await once(http, "listening");
  const codexBin = path.join(directory, "fake-codex.mjs");
  const transport = new StdioClientTransport({
    args: options.package
      ? [
          "exec",
          "--yes",
          "--install-links",
          `--package=${options.package}`,
          "--",
          "codex-app-server"
        ]
      : [serverPath],
    command: options.package ? "npm" : process.execPath,
    cwd: directory,
    env: {
      ...process.env,
      CODEX_APP_SERVER_SOCKET: socket,
      CODEX_BIN: options.catalog ? codexBin : path.join(directory, "absent"),
      NODE_USE_SYSTEM_CA: "1",
      npm_config_cache: path.join(directory, "npm-cache")
    },
    stderr: "pipe"
  });
  const versionFile = path.join(directory, "version");
  const schemaFile = path.join(directory, "catalog.json");
  const generatedFile = path.join(directory, "generations");
  if (options.catalog) {
    await writeFile(versionFile, "fixture-cli 1");
    await writeFile(
      schemaFile,
      JSON.stringify({
        ClientNotification: options.clientNotifications ?? { oneOf: [] },
        ClientRequest: options.catalog,
        ServerNotification: options.serverNotifications ?? { oneOf: [] },
        ServerRequest: options.serverRequests ?? { oneOf: [] }
      })
    );
    await writeFile(
      codexBin,
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  process.stdout.write(readFileSync(${JSON.stringify(versionFile)}, "utf-8"));
} else {
  appendFileSync(${JSON.stringify(generatedFile)}, "generated\\n");
  const schemas = JSON.parse(readFileSync(${JSON.stringify(schemaFile)}, "utf-8"));
  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(process.argv[5] + "/" + name + ".json", JSON.stringify(schema));
  }
}
`
    );
    await chmod(codexBin, 0o755);
  }
  const client = new Client({ name: "fixture", version: "1" });
  context.after(async () => {
    await client.close();
    for (const ws of connections) {
      ws.terminate();
    }
    await promisify(wsServer.close.bind(wsServer))();
    await promisify(http.close.bind(http))();
    await rm(directory, { force: true, recursive: true });
  });
  await client.connect(transport);
  return {
    client,
    connections,
    generatedFile,
    requests,
    schemaFile,
    socket,
    versionFile
  };
};

/**
 * Decode an MCP tool's JSON result while preserving the error flag for assertions.
 */
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ arguments: args, name });
  return {
    error: result.isError === true,
    text: result.content[0].text,
    value: result.isError ? null : JSON.parse(result.content[0].text)
  };
};

test("lists self-describing curated tools and all sources without repairing metadata", async (t) => {
  const { client, requests } = await fixture(t, ({ reply }) => {
    reply({
      data: [{ id: "fixture-thread", preview: "Fixture", source: "exec" }]
    });
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  for (const tool of tools) {
    assert.ok(tool.description);
    for (const field of Object.values(tool.inputSchema.properties)) {
      assert.ok(field.description);
    }
  }
  assert.equal(
    tools.find((tool) => tool.name === "codex_threads").annotations
      .readOnlyHint,
    true
  );
  const result = await call(client, "codex_threads");
  assert.equal(result.error, false);
  assert.equal(result.value[0].id, "fixture-thread");
  assert.deepEqual(requests.at(-1).params.sourceKinds, SOURCE_KINDS);
  assert.equal(requests.at(-1).params.useStateDbOnly, true);
});

test("packed executable includes and registers every feature module", async (t) => {
  const directory = await mkdtemp("/tmp/sinon-mcp-package-");
  t.after(() => rm(directory, { force: true, recursive: true }));
  const { stdout } = await promisify(execFile)(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    {
      cwd: path.dirname(serverPath),
      env: {
        ...process.env,
        npm_config_cache: path.join(directory, "npm-cache")
      }
    }
  );
  const [packed] = JSON.parse(stdout);
  assert.ok(!packed.files.some((entry) => entry.path === "lib/raw-call.mjs"));
  assert.ok(
    !packed.files.some((entry) => entry.path === "monitors/monitors.json")
  );
  for (const file of [
    "server.mjs",
    "monitor.mjs",
    "lib/monitor.mjs",
    "lib/connection.mjs",
    "lib/thread-tools.mjs",
    "lib/mcp-tool.mjs",
    "lib/native-session.mjs",
    "lib/session-transport.mjs",
    "skills/thread-control/SKILL.md",
    "skills/thread-control/assets/monitor.json",
    "skills/thread-control/references/monitor.md",
    "lib/turn-tools.mjs",
    "lib/thread-admin.mjs",
    "lib/catalog.mjs",
    "lib/policy.mjs",
    "lib/queue.mjs",
    "lib/turn.mjs",
    "lib/schema.mjs"
  ]) {
    assert.ok(
      packed.files.some((entry) => entry.path === file),
      file
    );
  }
  const { client, requests } = await fixture(
    t,
    ({ message, reply }) => {
      if (message.method === "thread/start") {
        reply({ thread: { id: "fixture-ephemeral" } });
      } else if (message.method === "mcpServer/tool/call") {
        reply({ structuredContent: { fixture: true } });
      } else {
        reply({ fixture: "raw" });
      }
    },
    { catalog: CATALOG, package: path.join(directory, packed.filename) }
  );
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "codex_threads",
      "codex_tail",
      "codex_start",
      "codex_send",
      "codex_steer",
      "codex_interrupt",
      "codex_loaded",
      "codex_fork",
      "codex_rename",
      "codex_goal",
      "codex_compact",
      "codex_mcp_tool",
      "codex_queue",
      "codex_methods",
      "codex_fs_readFile",
      "codex_config_write",
      "codex_thread_delete",
      "codex_account_rateLimitResetCredit_consume",
      "codex_thread_read"
    ]
  );
  const proxied = await call(client, "codex_mcp_tool", {
    server: "fixture-server",
    tool: "fixture-tool"
  });
  assert.deepEqual(proxied.value, { fixture: true });
  const started = requests.find((request) => request.method === "thread/start");
  assert.equal(started.params.ephemeral, true);
  assert.ok(
    started.params.cwd.startsWith("/tmp/sinon-mcp-") ||
      started.params.cwd.startsWith("/private/tmp/sinon-mcp-")
  );
  assert.deepEqual(requests.at(-1).params, {
    arguments: {},
    server: "fixture-server",
    threadId: "fixture-ephemeral",
    tool: "fixture-tool"
  });
  const native = await call(client, "codex_thread_read", {
    threadId: "fixture-thread"
  });
  assert.deepEqual(native.value, { fixture: "raw" });
  assert.deepEqual(requests.at(-1).params, { threadId: "fixture-thread" });
});

test("starts a new thread's first turn directly, while existing threads resume", async (t) => {
  const { client, requests } = await fixture(t, ({ message, reply }) => {
    if (message.method === "thread/start") {
      reply({ thread: { id: "fixture-new" } });
    } else if (message.method === "turn/start") {
      reply({ turn: { id: "fixture-turn" } });
    } else if (message.method === "thread/read") {
      reply({ thread: { turns: [] } });
    } else {
      reply({});
    }
  });
  const started = await call(client, "codex_start", {
    cwd: "/tmp",
    name: "Fixture",
    text: "Authorized fixture turn"
  });
  assert.equal(started.value.turn.status, "started");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "thread/start", "thread/name/set", "turn/start"]
  );
  await call(client, "codex_send", {
    text: "Authorized fixture turn",
    thread_id: "fixture-existing"
  });
  assert.deepEqual(
    requests.slice(-4).map((request) => request.method),
    ["initialize", "thread/read", "thread/resume", "turn/start"]
  );
});

test("rejects non-positive page and trailing counts before opening a daemon connection", async (t) => {
  const { client, requests } = await fixture(t, ({ reply }) => {
    reply({ thread: { turns: [{ id: "old" }, { id: "new" }] } });
  });
  const invalid = await Promise.all(
    [0, -1].flatMap((turns) => [
      call(client, "codex_tail", { thread_id: "fixture-thread", turns }),
      call(client, "codex_threads", { limit: turns })
    ])
  );
  for (const result of invalid) {
    assert.equal(result.error, true);
  }
  assert.equal(requests.length, 0);
  const result = await call(client, "codex_tail", {
    thread_id: "fixture-thread",
    turns: 1
  });
  assert.deepEqual(
    result.value.turns.map((turn) => turn.id),
    ["new"]
  );
});

test("buffers early completion, matches the turn, and returns structured failure diagnostics", async (t) => {
  const diagnostic = {
    codexErrorInfo: "usageLimitExceeded",
    message: "Fixture diagnostic"
  };
  const { client } = await fixture(t, ({ message, reply, ws }) => {
    if (message.method === "turn/start") {
      for (const note of [
        {
          method: "turn/completed",
          params: { turn: { id: "other", status: "completed" } }
        },
        {
          method: "item/completed",
          params: {
            item: { text: "Fixture final", type: "agentMessage" },
            turnId: "fixture-turn"
          }
        },
        {
          method: "turn/completed",
          params: {
            turn: { error: diagnostic, id: "fixture-turn", status: "failed" }
          }
        }
      ]) {
        ws.send(JSON.stringify(note));
      }
      reply({ turn: { id: "fixture-turn" } });
    } else {
      reply(message.method === "thread/read" ? { thread: { turns: [] } } : {});
    }
  });
  const result = await call(client, "codex_send", {
    text: "Authorized fixture turn",
    thread_id: "fixture-thread",
    wait_seconds: 2
  });
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.finalMessage, "Fixture final");
  assert.deepEqual(result.value.error, diagnostic);
});

test("reports wait timeout and socket closure during a turn", async (t) => {
  let drop = false;
  const { client } = await fixture(t, ({ message, reply, ws }) => {
    if (message.method === "turn/start") {
      reply({ turn: { id: "fixture-turn" } });
    } else if (message.method === "thread/read") {
      reply({ thread: { turns: [] } });
    } else {
      reply({});
    }
    if (message.method === "turn/start" && drop) {
      ws.close();
    }
  });
  const args = {
    text: "Authorized fixture turn",
    thread_id: "fixture-thread",
    wait_seconds: 0.05
  };
  const timeout = await call(client, "codex_send", args);
  assert.equal(timeout.value.status, "waitTimedOut");
  drop = true;
  const closed = await call(client, "codex_send", { ...args, wait_seconds: 2 });
  assert.equal(closed.value.status, "connectionClosed");
});

for (const failure of ["close", "frame"]) {
  test(`fails pending requests promptly on ${failure} and survives the connection failure`, async (t) => {
    let mode = failure;
    const { client } = await fixture(t, ({ reply, ws }) => {
      if (mode === "close") {
        ws.close();
      } else if (mode === "frame") {
        ws._socket.write(Buffer.from([0x83, 0x00]));
      } else {
        reply({ data: [] });
      }
    });
    const before = performance.now();
    const result = await call(client, "codex_threads");
    assert.equal(result.error, true);
    assert.ok(performance.now() - before < 2000);
    mode = "success";
    const recovered = await call(client, "codex_threads");
    assert.equal(recovered.error, false);
  });
}

test("closes rejected initialization connections and keeps reset-credit refusal offline", async (t) => {
  const { client, connections, requests } = await fixture(
    t,
    ({ message, ws }) => {
      ws.send(
        JSON.stringify({
          error: { code: -32_600, message: "Fixture incompatible protocol" },
          id: message.id
        })
      );
    },
    { catalog: CATALOG, failInitialize: true }
  );
  const refused = await call(
    client,
    "codex_account_rateLimitResetCredit_consume"
  );
  assert.equal(refused.error, true);
  assert.match(refused.text, /requires a separate direct human instruction/u);
  assert.equal(requests.length, 0);
  const failures = await Promise.all(
    Array.from({ length: 3 }, () => call(client, "codex_threads"))
  );
  for (const result of failures) {
    assert.match(result.text, /Fixture incompatible protocol/u);
  }
  await delay(50);
  assert.equal(connections.size, 0);
});

test("steers and interrupts only an in-progress last turn with its ID filled in", async (t) => {
  let status = "inProgress";
  const { client, requests } = await fixture(t, ({ message, reply }) => {
    if (message.method === "thread/read") {
      reply({
        thread: {
          turns: [
            { id: "old", status: "completed" },
            { id: "live", status }
          ]
        }
      });
    } else if (message.method === "turn/steer") {
      reply({ turnId: "live" });
    } else {
      reply({});
    }
  });
  const steered = await call(client, "codex_steer", {
    mode: "steer",
    text: "Authorized steer",
    thread_id: "fixture-thread"
  });
  assert.equal(steered.value.turnId, "live");
  assert.deepEqual(requests.at(-1).params, {
    expectedTurnId: "live",
    input: [{ text: "Authorized steer", type: "text" }],
    threadId: "fixture-thread"
  });
  await call(client, "codex_interrupt", { thread_id: "fixture-thread" });
  assert.deepEqual(requests.at(-1).params, {
    threadId: "fixture-thread",
    turnId: "live"
  });
  status = "completed";
  const before = requests.length;
  const refused = [
    await call(client, "codex_steer", {
      text: "Late",
      thread_id: "fixture-thread"
    }),
    await call(client, "codex_interrupt", { thread_id: "fixture-thread" })
  ];
  for (const result of refused) {
    assert.equal(result.error, true);
    assert.match(result.text, /not inProgress/u);
  }
  assert.deepEqual(
    requests
      .slice(before)
      .map((request) => request.method)
      .toSorted(),
    ["initialize", "initialize", "thread/read", "thread/read"]
  );
});

test("sends thin thread requests for fork, rename, goal, loaded list, and compaction", async (t) => {
  const { client, requests } = await fixture(t, ({ message, reply }) => {
    reply(message.method === "thread/fork" ? { thread: { id: "forked" } } : {});
  });
  const forked = await call(client, "codex_fork", {
    last_turn_id: "turn-1",
    name: "Fork",
    thread_id: "fixture-thread"
  });
  assert.equal(forked.value.threadId, "forked");
  const methods = () =>
    requests.map((request) => request.method).filter((m) => m !== "initialize");
  assert.deepEqual(methods(), ["thread/fork", "thread/name/set"]);
  assert.deepEqual(requests.find((r) => r.method === "thread/fork").params, {
    excludeTurns: true,
    lastTurnId: "turn-1",
    threadId: "fixture-thread"
  });
  await call(client, "codex_rename", {
    name: "New",
    thread_id: "fixture-thread"
  });
  await call(client, "codex_goal", {
    action: "get",
    thread_id: "fixture-thread"
  });
  await call(client, "codex_goal", {
    action: "set",
    objective: "Goal",
    status: "paused",
    thread_id: "fixture-thread",
    token_budget: 100
  });
  assert.deepEqual(requests.at(-1).params, {
    objective: "Goal",
    status: "paused",
    threadId: "fixture-thread",
    tokenBudget: 100
  });
  await call(client, "codex_goal", {
    action: "clear",
    thread_id: "fixture-thread"
  });
  await call(client, "codex_loaded", { limit: 5 });
  await call(client, "codex_compact", { thread_id: "fixture-thread" });
  assert.deepEqual(methods().slice(2), [
    "thread/name/set",
    "thread/goal/get",
    "thread/goal/set",
    "thread/goal/clear",
    "thread/loaded/list",
    "thread/compact/start"
  ]);
});

test("derives every native tool with exact parameter schemas and conservative annotations", async (t) => {
  const { client, requests } = await fixture(
    t,
    ({ reply }) => reply({ ok: true }),
    { catalog: CATALOG }
  );
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
  assert.ok(!tools.some((tool) => tool.name === "codex_call"));
  for (const method of CATALOG.oneOf.map(
    (entry) => entry.properties.method.enum[0]
  )) {
    const tool = tools.find(
      (item) => item.name === `codex_${method.replaceAll("/", "_")}`
    );
    assert.ok(tool, method);
    assert.match(tool.description, new RegExp(method, "u"));
    assert.match(tool.description, /class: (?:read|mutating)/u);
    assert.match(tool.description, /writer/u);
    assert.equal(
      tool.annotations.destructiveHint,
      !tool.annotations.readOnlyHint
    );
  }
  const readTool = tools.find((tool) => tool.name === "codex_fs_readFile");
  assert.equal(readTool.annotations.readOnlyHint, true);
  assert.deepEqual(readTool.inputSchema, CATALOG.oneOf[0].properties.params);
  const writeTool = tools.find((tool) => tool.name === "codex_config_write");
  assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.deepEqual(writeTool.inputSchema.$defs.Mode, CATALOG.definitions.Mode);
  assert.equal(writeTool.inputSchema.properties.mode.$ref, "#/$defs/Mode");
  const read = await call(client, "codex_fs_readFile", { path: "/x" });
  assert.deepEqual(read.value, { ok: true });
  assert.deepEqual(requests.at(-1).params, { path: "/x" });
  const literal = await call(client, "codex_config_write", {
    mode: "#/definitions/literal"
  });
  assert.equal(literal.error, false);
  assert.deepEqual(requests.at(-1).params, { mode: "#/definitions/literal" });
  const before = requests.length;
  const invalid = await call(client, "codex_config_write", { mode: "c" });
  assert.equal(invalid.error, true);
  assert.equal(requests.length, before);
  await Promise.all(
    [
      ["codex_thread_delete", /native codex archive/u],
      [
        "codex_account_rateLimitResetCredit_consume",
        /separate direct human instruction/u
      ]
    ].map(async ([name, reason]) => {
      const result = await call(client, name);
      assert.equal(result.error, true);
      assert.match(result.text, reason);
      assert.equal(requests.length, before);
    })
  );
  const listed = await call(client, "codex_methods", { method: "thread/read" });
  assert.equal(listed.value[0].tool, "codex_thread_read");
});

test("discovers definition-free catalogs with namespace-boundary filtering", async (t) => {
  const { client } = await fixture(t, ({ reply }) => reply({}), {
    catalog: {
      oneOf: ["fs/readFile", "fsSection/readFile"].map((method) => ({
        properties: { method: { enum: [method] }, params: { type: "object" } }
      }))
    }
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  await Promise.all(
    ["fs", "fs/"].map(async (prefix) => {
      const result = await call(client, "codex_methods", { prefix });
      assert.deepEqual(
        result.value.map((entry) => entry.method),
        ["fs/readFile"]
      );
    })
  );
});

test("retains curated tools when native parameter references are missing", async (t) => {
  await Promise.all(
    [{ $ref: "#/definitions/Missing" }].map(async (params) => {
      const { client } = await fixture(t, ({ reply }) => reply({}), {
        catalog: {
          definitions: {},
          oneOf: [{ properties: { method: { enum: ["future/read"] }, params } }]
        }
      });
      const { tools } = await client.listTools();
      assert.equal(tools.length, 14);
      assert.ok(!tools.some((tool) => tool.name === "codex_future_read"));
    })
  );
});

test("preserves boolean property schema semantics in SDK-compatible input schemas", async (t) => {
  const { client, requests } = await fixture(
    t,
    ({ reply }) => reply({ ok: true }),
    {
      catalog: {
        oneOf: [
          {
            properties: {
              method: { enum: ["future/json"] },
              params: {
                properties: { denied: false, payload: true },
                required: ["payload"],
                type: "object"
              }
            },
            required: ["method", "params"],
            type: "object"
          }
        ]
      }
    }
  );
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === "codex_future_json");
  assert.deepEqual(tool.inputSchema.properties, {
    denied: { not: {} },
    payload: {}
  });
  const invalid = await call(client, "codex_future_json", {
    denied: null,
    payload: true
  });
  assert.equal(invalid.error, true);
  assert.equal(requests.length, 0);
  const valid = await call(client, "codex_future_json", {
    payload: ["native", { arbitrary: true }]
  });
  assert.equal(valid.error, false);
  assert.deepEqual(requests.at(-1).params, {
    payload: ["native", { arbitrary: true }]
  });
});

test("wraps null and union parameters without changing native validation or dispatch", async (t) => {
  const nullParams = { type: "null" };
  const unionParams = {
    oneOf: [
      {
        additionalProperties: false,
        properties: { mode: { const: "a" } },
        required: ["mode"],
        type: "object"
      },
      { type: "string" }
    ]
  };
  const { client, requests } = await fixture(
    t,
    ({ reply }) => reply({ ok: true }),
    {
      catalog: {
        definitions: { Choice: unionParams },
        oneOf: [
          {
            properties: {
              method: { enum: ["future/null"] },
              params: nullParams
            },
            required: ["method", "params"],
            type: "object"
          },
          {
            properties: {
              method: { enum: ["future/union"] },
              params: { $ref: "#/definitions/Choice" }
            },
            required: ["method", "params"],
            type: "object"
          }
        ]
      }
    }
  );
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.find((tool) => tool.name === "codex_future_null").inputSchema
      .properties.params,
    nullParams
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === "codex_future_union").inputSchema
      .properties.params,
    unionParams
  );
  const invalid = await call(client, "codex_future_null");
  assert.equal(invalid.error, true);
  assert.equal(requests.length, 0);
  const nil = await call(client, "codex_future_null", { params: null });
  assert.equal(nil.error, false);
  assert.equal(requests.at(-1).params, null);
  const union = await call(client, "codex_future_union", {
    params: { mode: "a" }
  });
  assert.equal(union.error, false);
  assert.deepEqual(requests.at(-1).params, { mode: "a" });
  const before = requests.length;
  const extra = await call(client, "codex_future_union", {
    params: { extra: true, mode: "a" }
  });
  assert.equal(extra.error, true);
  assert.equal(requests.length, before);
});

test("maps ambiguous and reserved names uniquely and stably across catalog changes", async (t) => {
  const methods = [
    "thread/goal/get",
    "a/b",
    "a_b",
    "compact",
    "methods",
    "mcp/tool",
    "method/new",
    `future/${"long".repeat(40)}`
  ];
  const { client, schemaFile } = await fixture(t, ({ reply }) => reply({}), {
    catalog: {
      oneOf: methods.map((method) => ({
        properties: { method: { enum: [method] } }
      }))
    }
  });
  const firstResult = await call(client, "codex_methods");
  const first = firstResult.value;
  assert.equal(
    first.find((entry) => entry.method === "thread/goal/get").tool,
    "codex_thread_goal_get"
  );
  assert.equal(first.find((entry) => entry.method === "a/b").tool, "codex_a_b");
  const names = first.map((entry) => entry.tool);
  assert.equal(new Set(names).size, methods.length);
  assert.ok(
    names.every((name) => name.length <= 128 && /^[A-Za-z0-9_]+$/u.test(name))
  );
  const schemas = JSON.parse(await readFile(schemaFile, "utf-8"));
  schemas.ClientRequest.oneOf.push({
    properties: { method: { enum: ["a-b"] } }
  });
  await writeFile(schemaFile, JSON.stringify(schemas));
  const secondResult = await call(client, "codex_methods");
  const second = secondResult.value;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.ok(!names.includes(second.at(-1).tool));
});

test("rejects duplicate native method names atomically", async (t) => {
  const entry = { properties: { method: { enum: ["future/read"] } } };
  const { client } = await fixture(t, ({ reply }) => reply({}), {
    catalog: { oneOf: [entry, entry] }
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.ok(!tools.some((tool) => tool.name === "codex_future_read"));
});

test("propagates daemon active-turn and writer refusals without retrying", async (t) => {
  await Promise.all(
    ["thread/resume", "turn/start"].map(async (method) => {
      const { client, requests } = await fixture(
        t,
        ({ message, reply, ws }) => {
          if (message.method === method) {
            ws.send(
              JSON.stringify({
                error: {
                  code: -32_600,
                  message: "Thread has an in-progress turn or active writer"
                },
                id: message.id
              })
            );
          } else if (message.method === "thread/read") {
            reply({ thread: { turns: [] } });
          } else {
            reply({});
          }
        }
      );
      const result = await call(client, "codex_send", {
        text: "next",
        thread_id: "fixture-thread"
      });
      assert.equal(result.error, true);
      assert.match(result.text, /in-progress turn or active writer/u);
      assert.deepEqual(
        requests
          .filter((request) => request.method !== "initialize")
          .map((request) => request.method),
        method === "thread/resume"
          ? ["thread/read", "thread/resume"]
          : ["thread/read", "thread/resume", "turn/start"]
      );
    })
  );
});

test("serves only curated tools when the schema catalog is unavailable", async (t) => {
  const { client } = await fixture(t, ({ reply }) => reply({}), {
    methods: "fs"
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.ok(tools.some((tool) => tool.name === "codex_methods"));
});

test("queues active sends and delivers fresh turns in order, buffering early completion", async (t) => {
  const threadId = "fixture-queued";
  const turns = [{ id: "active", status: "inProgress" }];
  const delivered = [];
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/read") {
        reply({ thread: { turns } });
      } else if (message.method === "turn/start") {
        assert.notEqual(turns.at(-1).status, "inProgress");
        delivered.push(message.params.input[0].text);
        const turn = { id: `fresh-${delivered.length}`, status: "completed" };
        turns.push(turn);
        ws.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId, turn }
          })
        );
        reply({ turn });
      } else {
        reply({});
      }
    }
  );
  const first = await call(client, "codex_send", {
    text: "first",
    thread_id: threadId
  });
  const second = await call(client, "codex_send", {
    text: "second",
    thread_id: threadId
  });
  assert.equal(first.value.status, "queued");
  assert.equal(second.value.status, "queued");
  assert.ok(first.value.id);
  assert.deepEqual(delivered, []);
  assert.ok(!requests.some((request) => request.method === "turn/steer"));
  turns[0].status = "completed";
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: turns[0] }
      })
    );
  }
  await t.waitFor(() => assert.equal(delivered.length, 2), { timeout: 2000 });
  assert.deepEqual(delivered, ["first", "second"]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  const receipt = await call(client, "codex_queue", { thread_id: threadId });
  assert.deepEqual(
    receipt.value.messages.map((record) => record.status),
    ["completed", "completed"]
  );
  assert.deepEqual(
    receipt.value.messages.map((record) => record.turnId),
    ["fresh-1", "fresh-2"]
  );
});

test("default steering queues and a known response.interrupt failure avoids explicit steering", async (t) => {
  const turns = [
    {
      error: {
        message: "unsupported websocket request type: response.interrupt"
      },
      id: "failed",
      status: "failed"
    },
    { id: "active", status: "inProgress" }
  ];
  const { client, requests } = await fixture(t, ({ message, reply }) => {
    reply(message.method === "thread/read" ? { thread: { turns } } : {});
  });
  const queued = await call(client, "codex_steer", {
    mode: "steer",
    text: "later",
    thread_id: "fixture"
  });
  assert.equal(queued.value.status, "queued");
  assert.match(queued.value.reason, /response.interrupt/u);
  assert.ok(
    !requests.some(
      (request) =>
        request.method === "turn/steer" || request.method === "turn/start"
    )
  );
  const cancelled = await call(client, "codex_queue", {
    action: "cancel",
    thread_id: "fixture"
  });
  assert.equal(cancelled.value.messages[0].status, "refused");
  assert.match(cancelled.value.messages[0].reason, /Cancelled/u);
});

test("detects unsupported steering responses and does not retry an ambiguous write", async (t) => {
  const { client, requests } = await fixture(t, ({ message, reply, ws }) => {
    if (message.method === "thread/read") {
      reply({ thread: { turns: [{ id: "active", status: "inProgress" }] } });
    } else if (message.method === "turn/steer") {
      ws.send(
        JSON.stringify({
          error: {
            code: -32_000,
            message: "unsupported websocket request type: response.interrupt"
          },
          id: message.id
        })
      );
    } else {
      reply({});
    }
  });
  const refused = await call(client, "codex_steer", {
    mode: "steer",
    text: "now",
    thread_id: "fixture"
  });
  assert.equal(refused.value.status, "refused");
  assert.equal(refused.value.unsupportedInterrupt, true);
  assert.equal(
    requests.filter((request) => request.method === "turn/steer").length,
    1
  );
  assert.ok(!requests.some((request) => request.method === "turn/start"));
  const later = await call(client, "codex_steer", {
    mode: "steer",
    text: "later",
    thread_id: "fixture"
  });
  assert.equal(later.value.status, "queued");
  assert.equal(
    requests.filter((request) => request.method === "turn/steer").length,
    1
  );
  await call(client, "codex_queue", { action: "cancel", thread_id: "fixture" });
});

test("queue connection loss refuses undelivered messages without reconnecting", async (t) => {
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply }) => {
      reply(
        message.method === "thread/read"
          ? { thread: { turns: [{ id: "active", status: "inProgress" }] } }
          : {}
      );
    }
  );
  await call(client, "codex_send", { text: "later", thread_id: "fixture" });
  for (const ws of connections) {
    ws.close();
  }
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  const receipt = await call(client, "codex_queue", { thread_id: "fixture" });
  assert.equal(receipt.value.messages[0].status, "refused");
  assert.match(receipt.value.messages[0].reason, /connection closed/u);
  assert.ok(!requests.some((request) => request.method === "turn/start"));
});

test("queue writer refusal stops the batch without retrying or forcing another writer", async (t) => {
  let active = true;
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/read") {
        reply({
          thread: {
            turns: [
              { id: "active", status: active ? "inProgress" : "completed" }
            ]
          }
        });
      } else if (message.method === "turn/start") {
        ws.send(
          JSON.stringify({
            error: { code: -32_000, message: "active writer holds thread" },
            id: message.id
          })
        );
      } else {
        reply({});
      }
    }
  );
  await call(client, "codex_send", { text: "later", thread_id: "fixture" });
  active = false;
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "fixture",
          turn: { id: "active", status: "completed" }
        }
      })
    );
  }
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  const receipt = await call(client, "codex_queue", { thread_id: "fixture" });
  assert.equal(receipt.value.messages[0].status, "refused");
  assert.match(receipt.value.messages[0].reason, /active writer/u);
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    1
  );
});

test("queue rechecks a replacement active turn before delivery", async (t) => {
  let turns = [{ id: "original", status: "inProgress" }];
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply }) => {
      reply(message.method === "thread/read" ? { thread: { turns } } : {});
    }
  );
  await call(client, "codex_send", { text: "later", thread_id: "fixture" });
  const before = requests.filter(
    (request) => request.method === "thread/read"
  ).length;
  turns = [
    { id: "original", status: "completed" },
    { id: "replacement", status: "inProgress" }
  ];
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "fixture", turn: turns[0] }
      })
    );
  }
  await t.waitFor(
    () =>
      assert.ok(
        requests.filter((request) => request.method === "thread/read").length >
          before
      ),
    { timeout: 2000 }
  );
  assert.ok(!requests.some((request) => request.method === "turn/start"));
  const receipt = await call(client, "codex_queue", {
    action: "cancel",
    thread_id: "fixture"
  });
  assert.equal(receipt.value.messages[0].status, "refused");
});

test("refused server-initiated requests cannot wake queue delivery", async (t) => {
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply }) => {
      if (!message.error) {
        reply(
          message.method === "thread/read"
            ? { thread: { turns: [{ id: "active", status: "inProgress" }] } }
            : {}
        );
      }
    }
  );
  await call(client, "codex_send", { text: "later", thread_id: "fixture" });
  const before = requests.filter(
    (request) => request.method === "thread/read"
  ).length;
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        id: "server-completion",
        method: "turn/completed",
        params: {
          threadId: "fixture",
          turn: { id: "active", status: "completed" }
        }
      })
    );
  }
  await t.waitFor(
    () =>
      assert.ok(
        requests.some(
          (request) =>
            request.id === "server-completion" &&
            request.error?.code === -32_601
        )
      ),
    { timeout: 2000 }
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/read").length,
    before
  );
  await call(client, "codex_queue", { action: "cancel", thread_id: "fixture" });
});

test("an idle send waiting for completion permits authorized interruption of its active turn", async (t) => {
  let active = false;
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply }) => {
      if (message.method === "thread/read") {
        reply({
          thread: {
            turns: active ? [{ id: "active", status: "inProgress" }] : []
          }
        });
      } else if (message.method === "turn/start") {
        active = true;
        reply({ turn: { id: "active" } });
      } else if (message.method === "turn/interrupt") {
        active = false;
        for (const ws of connections) {
          ws.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "fixture",
                turn: { id: "active", status: "interrupted" }
              }
            })
          );
        }
        reply({});
      } else {
        reply({});
      }
    }
  );
  const sending = call(client, "codex_send", {
    text: "now",
    thread_id: "fixture",
    wait_seconds: 2
  });
  await t.waitFor(
    () =>
      assert.ok(requests.some((request) => request.method === "turn/start")),
    { timeout: 2000 }
  );
  const interrupted = await call(client, "codex_interrupt", {
    thread_id: "fixture"
  });
  assert.equal(interrupted.value.status, "interrupted");
  const sent = await sending;
  assert.equal(sent.value.status, "interrupted");
});

test("queue deadline bounds stalled initialization before delivery", async (t) => {
  const { requests, socket, connections } = await fixture(t, () => {}, {
    failInitialize: true
  });
  const previousSocket = process.env.CODEX_APP_SERVER_SOCKET;
  process.env.CODEX_APP_SERVER_SOCKET = socket;
  t.after(() => {
    closeQueues();
    if (previousSocket === undefined) {
      delete process.env.CODEX_APP_SERVER_SOCKET;
    } else {
      process.env.CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queued = enqueueMessage("deadline-fixture", "pending text");
  await t.waitFor(() => assert.equal(requests.length, 1), { timeout: 2000 });
  t.mock.timers.tick(1_800_000);
  const result = await queued;
  assert.equal(result.status, "refused");
  assert.match(result.reason, /deadline expired/u);
  t.mock.timers.reset();
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize"]
  );
});

const direction = (method) => ({
  oneOf: [{ properties: { method: { enum: [method] } } }]
});

test("validates native parameters and keeps non-client directions discovery-only", async (t) => {
  const { client, requests } = await fixture(
    t,
    ({ reply }) => reply({ ok: true }),
    {
      catalog: CATALOG,
      clientNotifications: direction("initialized"),
      serverNotifications: direction("thread/status/changed"),
      serverRequests: direction("item/commandExecution/requestApproval")
    }
  );
  await Promise.all(
    [
      ["codex_config_write", { mode: "invalid" }],
      ["codex_fs_readFile", {}],
      ["codex_fs_readFile", { path: 2 }],
      ["codex_initialized", {}],
      ["codex_item_commandExecution_requestApproval", {}],
      ["codex_thread_status_changed", {}],
      ["codex_absent_method", {}]
    ].map(async ([name, args]) => {
      const result = await call(client, name, args);
      assert.equal(result.error, true);
      assert.equal(requests.length, 0);
    })
  );
  await Promise.all(
    [
      ["serverRequest", "item/commandExecution/requestApproval"],
      ["serverNotification", "thread/status/changed"],
      ["clientNotification", "initialized"]
    ].map(async ([kind, method]) => {
      const result = await call(client, "codex_methods", { kind, method });
      assert.equal(result.value[0].tool, "discovery_only");
    })
  );
  const valid = await call(client, "codex_config_write", {
    extra: true,
    mode: "b"
  });
  assert.deepEqual(valid.value, { ok: true });
  assert.deepEqual(requests.at(-1).params, { extra: true, mode: "b" });
});

test("refreshes native tools and notifications on version and same-version schema changes", async (t) => {
  const { client, requests, schemaFile, versionFile } = await fixture(
    t,
    ({ reply }) => reply({ ok: true }),
    {
      catalog: {
        ...CATALOG,
        definitions: {
          ...CATALOG.definitions,
          Unrelated: { description: "unrelated".repeat(10_000), type: "string" }
        }
      }
    }
  );
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes += 1;
  });
  assert.equal(client.getServerCapabilities().tools.listChanged, true);
  const before = await call(client, "codex_methods", {
    method: "config/write"
  });
  assert.ok(JSON.stringify(before.value[0].params).length < 1000);
  assert.equal(before.value[0].params.$defs.Unrelated, undefined);
  const schemas = JSON.parse(await readFile(schemaFile, "utf-8"));
  schemas.ClientRequest.definitions.Mode.enum.push("future");
  schemas.ClientRequest.oneOf.push(
    {
      properties: {
        method: { enum: ["future/new"] },
        params: {
          additionalProperties: false,
          properties: { count: { minimum: 1, type: "integer" } },
          required: ["count"],
          type: "object"
        }
      },
      required: ["method", "params"],
      type: "object"
    },
    {
      properties: {
        method: { enum: ["command/exec/newNative"] },
        params: { type: "object" }
      },
      required: ["method", "params"],
      type: "object"
    }
  );
  await writeFile(schemaFile, JSON.stringify(schemas));
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "codex_future_new"));
  await t.waitFor(() => assert.equal(changes, 1));
  const updated = await call(client, "codex_config_write", { mode: "future" });
  assert.equal(updated.error, false);
  const requestCount = requests.length;
  const invalid = await call(client, "codex_future_new", {
    count: 0,
    extra: true
  });
  assert.equal(invalid.error, true);
  assert.equal(requests.length, requestCount);
  const future = await call(client, "codex_future_new", { count: 1 });
  assert.equal(future.error, false);
  const futureCommand = await call(client, "codex_command_exec_newNative", {});
  assert.equal(futureCommand.error, false);
  assert.equal(requests.at(-1).method, "command/exec/newNative");
  await client.listTools();
  assert.equal(changes, 1);
  await writeFile(versionFile, "fixture-cli 2");
  const versionChanged = await call(client, "codex_config_write", {
    mode: "future"
  });
  assert.equal(versionChanged.error, false);
  await t.waitFor(() => assert.equal(changes, 2));
  schemas.ClientRequest.oneOf = schemas.ClientRequest.oneOf.filter(
    (entry) => entry.properties.method.enum[0] !== "future/new"
  );
  await writeFile(schemaFile, JSON.stringify(schemas));
  const removed = await client.listTools();
  assert.ok(!removed.tools.some((tool) => tool.name === "codex_future_new"));
  const refused = await call(client, "codex_future_new", { count: 1 });
  assert.equal(refused.error, true);
});

test("refuses native calls offline when current schema validation is unavailable", async (t) => {
  const { client, requests, versionFile } = await fixture(
    t,
    ({ reply }) => reply({}),
    { catalog: CATALOG }
  );
  await rm(versionFile);
  const result = await call(client, "codex_thread_read", {
    threadId: "fixture"
  });
  assert.equal(result.error, true);
  assert.equal(requests.length, 0);
  const refused = await call(
    client,
    "codex_account_rateLimitResetCredit_consume"
  );
  assert.equal(refused.error, true);
  assert.match(refused.text, /separate direct human instruction/u);
  assert.equal(requests.length, 0);
});

test("rejects discovery after valid generation fails catalog derivation", async (t) => {
  const { client, schemaFile } = await fixture(t, ({ reply }) => reply({}), {
    catalog: CATALOG
  });
  const before = await client.listTools();
  const schemas = JSON.parse(await readFile(schemaFile, "utf-8"));
  const method = { properties: { method: { enum: ["future/duplicate"] } } };
  schemas.ClientRequest.oneOf.push(method, method);
  await writeFile(schemaFile, JSON.stringify(schemas));
  const discovery = await call(client, "codex_methods");
  assert.equal(discovery.error, true);
  assert.match(discovery.text, /Duplicated native tool name/u);
  const after = await client.listTools();
  assert.deepEqual(after.tools, before.tools);
});

test("cancels native calls during schema refresh before opening a socket", async (t) => {
  const { client, requests, versionFile } = await fixture(
    t,
    ({ reply }) => reply({}),
    { catalog: CATALOG }
  );
  await writeFile(versionFile, "fixture-cli 2");
  const controller = new AbortController();
  const pending = client.callTool(
    { arguments: { mode: "a" }, name: "codex_config_write" },
    undefined,
    { signal: controller.signal }
  );
  const rejected = assert.rejects(pending);
  controller.abort(new Error("Fixture cancellation"));
  await rejected;
  await client.listTools();
  assert.equal(requests.length, 0);
});

test("cancellation closes a stalled native initialize connection without dispatching", async (t) => {
  const { client, connections, requests } = await fixture(t, () => {}, {
    catalog: CATALOG,
    failInitialize: true
  });
  const controller = new AbortController();
  const pending = client.callTool(
    { arguments: { mode: "a" }, name: "codex_config_write" },
    undefined,
    { signal: controller.signal }
  );
  const rejected = assert.rejects(pending);
  await t.waitFor(() => assert.equal(requests.length, 1), { timeout: 2000 });
  controller.abort(new Error("Fixture cancellation"));
  await rejected;
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize"]
  );
});

const commandCatalog = {
  oneOf: [
    "command/exec",
    "command/exec/write",
    "command/exec/resize",
    "command/exec/terminate",
    "fs/watch",
    "fs/unwatch"
  ].map((method) => ({
    properties: { method: { enum: [method] }, params: { type: "object" } },
    required: ["method", "params"],
    type: "object"
  }))
};

test("keeps interactive command follow-ups on their originating connection and returns streamed output", async (t) => {
  let owner;
  let complete;
  const { client, connections, requests } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "command/exec") {
        owner = ws;
        complete = reply;
      } else {
        assert.equal(ws, owner);
        reply({});
        if (message.method === "command/exec/terminate") {
          ws.send(
            JSON.stringify({
              method: "command/exec/outputDelta",
              params: {
                capReached: false,
                deltaBase64: "Zml4dHVyZQ==",
                processId: "fixture-process",
                stream: "stdout"
              }
            })
          );
          complete({ exitCode: 0, stderr: "", stdout: "" });
        }
      }
    },
    { catalog: commandCatalog }
  );
  const execution = call(client, "codex_command_exec", {
    command: ["fixture"],
    processId: "fixture-process",
    streamStdin: true,
    streamStdoutStderr: true
  });
  await t.waitFor(() => assert.ok(owner), { timeout: 2000 });
  const written = await call(client, "codex_command_exec_write", {
    deltaBase64: "eA==",
    processId: "fixture-process"
  });
  assert.equal(written.error, false);
  const resized = await call(client, "codex_command_exec_resize", {
    processId: "fixture-process",
    size: { cols: 80, rows: 24 }
  });
  assert.equal(resized.error, false);
  const terminated = await call(client, "codex_command_exec_terminate", {
    processId: "fixture-process"
  });
  assert.equal(terminated.error, false);
  const result = await execution;
  assert.equal(result.error, false);
  assert.equal(
    result.value.notifications[0].params.deltaBase64,
    "Zml4dHVyZQ=="
  );
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  assert.equal(
    requests.filter((request) => request.method === "initialize").length,
    1
  );
  const absent = await call(client, "codex_command_exec_write", {
    processId: "fixture-process"
  });
  assert.equal(absent.error, true);
  assert.equal(connections.size, 0);
});

test("cancelling an active native command releases its connection and process identifier", async (t) => {
  const { client, connections, requests } = await fixture(t, () => {}, {
    catalog: commandCatalog
  });
  const controller = new AbortController();
  const pending = client.callTool(
    {
      arguments: { command: ["fixture"], processId: "fixture-cancel" },
      name: "codex_command_exec"
    },
    undefined,
    { signal: controller.signal }
  );
  const rejected = assert.rejects(pending);
  await t.waitFor(
    () =>
      assert.ok(requests.some((request) => request.method === "command/exec")),
    { timeout: 2000 }
  );
  controller.abort(new Error("Fixture cancellation"));
  await rejected;
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  const absent = await call(client, "codex_command_exec_write", {
    processId: "fixture-cancel"
  });
  assert.equal(absent.error, true);
  assert.equal(connections.size, 0);
  assert.equal(
    requests.filter((request) => request.method === "command/exec").length,
    1
  );
});

test("keeps watch notifications live until native unwatch or MCP transport closure", async (t) => {
  let owner;
  const { client, connections } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "fs/watch") {
        owner = ws;
      } else {
        assert.equal(ws, owner);
      }
      reply({});
    },
    { catalog: commandCatalog }
  );
  const events = [];
  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    ({ params }) => {
      events.push(params.data);
    }
  );
  const started = await call(client, "codex_fs_watch", {
    path: "/fixture",
    watchId: "fixture-watch"
  });
  assert.equal(started.error, false);
  assert.equal(connections.size, 1);
  owner.send(
    JSON.stringify({
      method: "fs/changed",
      params: { paths: ["/fixture"], watchId: "fixture-watch" }
    })
  );
  await t.waitFor(() => assert.equal(events.length, 1), { timeout: 2000 });
  const removed = await call(client, "codex_fs_unwatch", {
    watchId: "fixture-watch"
  });
  assert.equal(removed.error, false);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  const watched = await call(client, "codex_fs_watch", {
    path: "/fixture",
    watchId: "fixture-watch"
  });
  assert.equal(watched.error, false);
  await client.close();
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("retains the last catalog atomically after a failed refresh and refuses stale validation", async (t) => {
  const { client, requests, schemaFile } = await fixture(
    t,
    ({ reply }) => reply({}),
    { catalog: CATALOG }
  );
  const before = await client.listTools();
  await writeFile(schemaFile, "invalid fixture schema");
  const after = await client.listTools();
  assert.deepEqual(after.tools, before.tools);
  const result = await call(client, "codex_fs_readFile", { path: "/x" });
  assert.equal(result.error, true);
  assert.equal(requests.length, 0);
});

test("watch logging respects stdout backpressure and SDK closure releases sockets and drains", async (t) => {
  const { socket, connections } = await fixture(t, ({ reply }) => reply({}));
  const previousSocket = process.env.CODEX_APP_SERVER_SOCKET;
  process.env.CODEX_APP_SERVER_SOCKET = socket;
  let finishWrite;
  const stdin = new PassThrough();
  const stdout = new Writable({
    highWaterMark: 64,
    write(_bytes, _encoding, done) {
      finishWrite = done;
    }
  });
  const server = new Server(
    { name: "fixture", version: "1" },
    { capabilities: { logging: {} } }
  );
  const native = createNativeSessions(server);
  const transport = new SessionTransport(native.close, stdin, stdout, {
    maxBufferSize: 1024
  });
  t.after(async () => {
    native.close();
    await server.close();
    stdin.destroy();
    stdout.destroy();
    if (previousSocket === undefined) {
      delete process.env.CODEX_APP_SERVER_SOCKET;
    } else {
      process.env.CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });
  await server.connect(transport);
  await native.request("fs/watch", {
    path: "/fixture",
    watchId: "backpressure"
  });
  const [owner] = connections;
  const note = JSON.stringify({
    method: "fs/changed",
    params: { paths: ["/fixture"], watchId: "backpressure" }
  });
  for (let count = 0; count < 200; count += 1) {
    owner.send(note);
  }
  await t.waitFor(() => assert.equal(stdout.listenerCount("drain"), 1));
  const buffered = stdout.writableLength;
  await delay(50);
  assert.equal(stdout.writableLength, buffered);
  assert.equal(stdout.listenerCount("drain"), 1);
  stdin.write(Buffer.alloc(1025));
  await t.waitFor(() => assert.equal(connections.size, 0));
  assert.equal(stdout.listenerCount("drain"), 0);
  assert.equal(stdin.readableEnded, false);
  await assert.rejects(
    native.request("fs/watch", { path: "/fixture", watchId: "closed" }),
    /closed/u
  );
  finishWrite();
});

/**
 * Run the packaged monitor against the same fixture socket and decode line events.
 */
const monitor = (context, socket, args, env = {}) => {
  const child = spawn(process.execPath, [monitorPath, ...args], {
    env: {
      ...process.env,
      CODEX_APP_SERVER_MONITOR_STATUSES: "",
      CODEX_APP_SERVER_MONITOR_THREADS: "",
      CODEX_APP_SERVER_SOCKET: socket,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const events = [];
  let buffered = "";
  child.stdout.on("data", (bytes) => {
    buffered += bytes.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop();
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
  });
  const exited = once(child, "close");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  });
  return { child, events, exited };
};

test("packaged monitor watches configured native transitions and classifies terminal failures", async (t) => {
  let status = "active";
  let turn = { id: "initial", status: "inProgress" };
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      reply(
        message.method === "thread/read"
          ? { thread: { status: { type: status } } }
          : { data: [turn] }
      );
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events[0]?.status, "active"), {
    timeout: 2000
  });
  const notify = (params) => {
    for (const ws of connections) {
      ws.send(JSON.stringify({ method: "thread/status/changed", params }));
    }
  };
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        id: "server-status",
        method: "thread/status/changed",
        params: { status: { type: "systemError" }, threadId: "watched" }
      })
    );
  }
  await t.waitFor(
    () =>
      assert.ok(
        requests.some(
          (request) =>
            request.id === "server-status" && request.error?.code === -32_601
        )
      ),
    { timeout: 2000 }
  );
  assert.equal(events.length, 1);
  notify({ status: { type: "idle" }, threadId: "other" });
  status = "idle";
  turn = {
    error: { message: "fixture failure" },
    id: "initial",
    status: "failed"
  };
  notify({ status: { type: "idle" }, threadId: "watched" });
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  notify({ status: { type: "idle" }, threadId: "watched" });
  notify({ status: { type: "notLoaded" }, threadId: "watched" });
  notify({ status: { type: "systemError" }, threadId: "watched" });
  await t.waitFor(() => assert.equal(events.length, 4), { timeout: 2000 });
  assert.deepEqual(
    events.map((event) => event.status),
    ["active", "failed", "idle", "systemError"]
  );
  assert.equal(events.at(-1).previous, "notLoaded");
  assert.equal(events[1].turnId, "initial");
  assert.ok(events.every((event) => event.threadId === "watched"));
  assert.ok(
    requests.every(
      (request) =>
        request.error ||
        [
          "initialize",
          "thread/read",
          "thread/turns/list",
          "thread/items/list"
        ].includes(request.method)
    )
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor excludes unloaded activity while preserving subsequent failure events", async (t) => {
  let turn = null;
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      reply(
        message.method === "thread/read"
          ? { thread: { status: { type: "notLoaded" } } }
          : { data: turn ? [turn] : [] }
      );
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(
    () =>
      assert.ok(requests.some((request) => request.method === "thread/read")),
    { timeout: 2000 }
  );
  assert.deepEqual(events, []);
  const [owner] = connections;
  turn = {
    error: { code: "model_not_found" },
    id: "after-unload",
    status: "failed"
  };
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "watched" }
    })
  );
  await t.waitFor(() => assert.equal(events.length, 1), { timeout: 2000 });
  assert.deepEqual(
    events.map(({ event, previous, status }) => ({ event, previous, status })),
    [{ event: "turnError", previous: "notLoaded", status: "failed" }]
  );
  assert.equal(events[0].error.code, "model_not_found");
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: { type: "notLoaded" }, threadId: "watched" }
    })
  );
  owner.send(
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "watched",
        turn: {
          error: { message: "fixture terminal failure" },
          id: "later-failure",
          status: "failed"
        }
      }
    })
  );
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.equal(events[1].event, "turnError");
  assert.equal(events[1].previous, "notLoaded");
  assert.equal(events[1].status, "failed");
  assert.equal(events[1].turnId, "later-failure");
  assert.ok(
    requests
      .filter((request) => request.method === "thread/turns/list")
      .every((request) => request.params.itemsView === "notLoaded")
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor status filters and startup deadlines preserve read-only behavior", async (t) => {
  const { connections, requests, socket } = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        name: "Synthetic selection",
        status: { type: "idle" },
        turns: []
      }
    })
  );
  const { events, exited } = monitor(t, socket, [
    "--include-initial",
    "--thread",
    "watched",
    "--status",
    "systemError",
    "--timeout-seconds",
    "0.4"
  ]);
  await t.waitFor(
    () =>
      assert.ok(requests.some((request) => request.method === "thread/read")),
    { timeout: 2000 }
  );
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "systemError" }, threadId: "watched" }
      })
    );
  }
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(
    events.map((event) => event.status),
    ["systemError"]
  );
});

test("wildcard monitor snapshots every loaded page and reports distinct turn errors without unchanged events", async (t) => {
  const error = { code: "model_not_found", message: "Fixture model is absent" };
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      if (message.method === "thread/loaded/list") {
        reply(
          message.params.cursor
            ? { data: ["second", "third"], nextCursor: null }
            : { data: ["first"], nextCursor: "next-page" }
        );
      } else if (message.method === "thread/read") {
        reply({
          thread: {
            status: {
              type: message.params.threadId === "third" ? "systemError" : "idle"
            }
          }
        });
      } else {
        reply({
          data:
            message.params.threadId === "second"
              ? [{ error, id: "initial-failure", status: "failed" }]
              : []
        });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*",
    "--status",
    "idle",
    "--status",
    "failed",
    "--status",
    "systemError"
  ]);
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  assert.deepEqual(
    requests
      .filter((request) => request.method === "thread/loaded/list")
      .map((request) => request.params),
    [{}, { cursor: "next-page" }]
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === "threadStatus")
      .map((event) => event.threadId),
    ["first", "second", "third"]
  );
  const [owner] = connections;
  for (const threadId of ["first", "second", "third"]) {
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          status: { type: threadId === "third" ? "systemError" : "idle" },
          threadId
        }
      })
    );
  }
  await delay(50);
  assert.equal(events.length, 3);
  for (const turnId of [
    "later-failure",
    "consecutive-failure",
    "consecutive-failure"
  ]) {
    owner.send(
      JSON.stringify({
        method: "error",
        params: { error, threadId: "second", turnId, willRetry: false }
      })
    );
  }
  await t.waitFor(() => assert.equal(events.length, 5), { timeout: 2000 });
  assert.deepEqual(
    events
      .filter((event) => event.event === "turnError")
      .map((event) => event.turnId),
    ["later-failure", "consecutive-failure"]
  );
  assert.ok(
    events
      .filter((event) => event.event === "turnError")
      .every((event) => event.error.code === "model_not_found")
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor deduplicates snapshot failures across an older startup notification backlog", async (t) => {
  const error = { code: "model_not_found", message: "Fixture model is absent" };
  let injected = false;
  const { connections, socket } = await fixture(
    t,
    ({ message, reply, connections: targets }) => {
      if (message.method === "thread/turns/list") {
        if (!injected) {
          injected = true;
          const [owner] = targets;
          for (const id of ["older", "newer", "older"]) {
            owner.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "watched",
                  turn: { error, id, status: "failed" }
                }
              })
            );
          }
        }
        reply({ data: [{ error, id: "newer", status: "failed" }] });
      } else {
        reply({ thread: { status: "idle" } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events.length, 3));
  assert.equal(events[0].event, "threadStatus");
  assert.equal(events[0].previous, null);
  assert.equal(events[0].status, "idle");
  assert.deepEqual(
    events
      .filter((event) => event.event === "turnError")
      .map((event) => event.turnId),
    ["older", "newer"]
  );
  const [owner] = connections;
  for (const id of ["newer", "future", "newer"]) {
    owner.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "watched", turn: { error, id, status: "failed" } }
      })
    );
  }
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: "idle", threadId: "watched" }
    })
  );
  await t.waitFor(() => assert.equal(events.length, 4));
  await delay(50);
  assert.deepEqual(
    events
      .filter((event) => event.event === "turnError")
      .map((event) => event.turnId),
    ["older", "newer", "future"]
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0));
});

for (const includePreviousNotLoaded of [false, true]) {
  test(`monitor selects unloaded terminal successes separately and retains fresh failures: ${includePreviousNotLoaded}`, async (t) => {
    let turn = {
      completedAt: 0,
      id: "historical",
      items: [],
      status: "failed"
    };
    let name = null;
    const { connections, requests, socket } = await fixture(
      t,
      ({ message, reply }) => {
        reply(
          message.method === "thread/read"
            ? { thread: { name, status: { type: "notLoaded" } } }
            : {
                data:
                  message.method === "thread/loaded/list" ? ["watched"] : [turn]
              }
        );
      }
    );
    const { child, events, exited } = monitor(t, socket, [
      "--include-unnamed",
      "--thread",
      "*",
      ...(includePreviousNotLoaded ? ["--include-previous-not-loaded"] : [])
    ]);
    await t.waitFor(() =>
      assert.ok(requests.some(({ method }) => method === "thread/read"))
    );
    await delay(30);
    assert.deepEqual(events, []);
    const [owner] = connections;
    const terminal = (completed) =>
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "watched", turn: completed }
        })
      );
    terminal({
      id: "loaded-result",
      items: [
        {
          phase: "final_answer",
          text: "Synthetic loaded result",
          type: "agentMessage"
        }
      ],
      status: "completed"
    });
    turn = {
      error: { message: "Synthetic failure" },
      id: "fresh-failure",
      items: [
        {
          phase: "commentary",
          text: "Synthetic progress",
          type: "agentMessage"
        }
      ],
      status: "failed"
    };
    terminal(turn);
    terminal(turn);
    await t.waitFor(() =>
      assert.equal(events.length, includePreviousNotLoaded ? 2 : 1)
    );
    assert.equal(events.at(-1).event, "turnError");
    assert.equal(events.at(-1).previous, "notLoaded");
    assert.equal(events.at(-1).finalMessage, null);
    assert.equal(events.at(-1).threadName, null);
    assert.deepEqual(events.at(-1).error, { message: "Synthetic failure" });
    if (includePreviousNotLoaded) {
      assert.equal(events[0].event, "turnCompleted");
      assert.equal(events[0].previous, "notLoaded");
      assert.equal(events[0].finalMessage, "Synthetic loaded result");
    }
    name = "Synthetic renamed session";
    turn = {
      error: { message: "Synthetic distinct failure" },
      id: "distinct-failure",
      items: [],
      status: "failed"
    };
    terminal(turn);
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "systemError" }, threadId: "watched" }
      })
    );
    await t.waitFor(() =>
      assert.equal(events.length, includePreviousNotLoaded ? 4 : 3)
    );
    assert.equal(events.at(-2).turnId, "distinct-failure");
    assert.equal(events.at(-2).finalMessage, null);
    assert.equal(events.at(-2).threadName, name);
    assert.equal(events.at(-1).status, "systemError");
    assert.equal(events.at(-1).previous, "notLoaded");
    assert.equal(events.at(-1).threadName, name);
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "notLoaded" }, threadId: "watched" }
      })
    );
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: "watched" }
      })
    );
    await t.waitFor(() =>
      assert.equal(
        requests.filter(({ method }) => method === "thread/turns/list").length,
        2
      )
    );
    await delay(30);
    assert.equal(
      events.filter(({ turnId }) => turnId === "fresh-failure").length,
      1
    );
    assert.equal(events.length, includePreviousNotLoaded ? 5 : 3);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    await t.waitFor(() => assert.equal(connections.size, 0));
  });
}

for (const selection of ["*", "watched"]) {
  for (const explicitStatuses of [false, true]) {
    test(`monitor hides unloaded activity but preserves a real completion: ${selection}/${explicitStatuses}`, async (t) => {
      let turn = { completedAt: 0, id: "historical", status: "failed" };
      const { connections, requests, socket } = await fixture(
        t,
        ({ message, reply }) => {
          reply(
            message.method === "thread/read"
              ? {
                  thread: {
                    name: "Synthetic session",
                    status: { type: "notLoaded" }
                  }
                }
              : {
                  data:
                    message.method === "thread/loaded/list"
                      ? ["watched"]
                      : [turn]
                }
          );
        }
      );
      const { child, events, exited } = monitor(t, socket, [
        "--thread",
        selection,
        ...(explicitStatuses
          ? [
              "--status",
              "idle",
              "--status",
              "failed",
              "--status",
              "systemError"
            ]
          : [])
      ]);
      await t.waitFor(() =>
        assert.ok(requests.some(({ method }) => method === "thread/read"))
      );
      await delay(30);
      assert.deepEqual(events, []);
      const [owner] = connections;
      const notify = (type) =>
        owner.send(
          JSON.stringify({
            method: "thread/status/changed",
            params: { status: { type }, threadId: "watched" }
          })
        );
      notify("idle");
      await t.waitFor(() =>
        assert.equal(
          requests.filter(({ method }) => method === "thread/turns/list")
            .length,
          2
        )
      );
      await delay(30);
      assert.deepEqual(events, []);
      notify("notLoaded");
      notify("active");
      turn = {
        id: "completed",
        items: [
          {
            phase: "final_answer",
            text: "Synthetic completed answer",
            type: "agentMessage"
          }
        ],
        status: "completed"
      };
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "watched", turn }
        })
      );
      notify("idle");
      await t.waitFor(() => assert.equal(events.length, 2));
      assert.deepEqual(
        events.map(({ event, previous, status, threadName }) => ({
          event,
          previous,
          status,
          threadName
        })),
        [
          {
            event: "turnCompleted",
            previous: "active",
            status: "idle",
            threadName: "Synthetic session"
          },
          {
            event: "threadStatus",
            previous: "active",
            status: "idle",
            threadName: "Synthetic session"
          }
        ]
      );
      assert.equal(events[0].turnId, "completed");
      assert.equal(events[0].finalMessage, "Synthetic completed answer");
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      await t.waitFor(() => assert.equal(connections.size, 0));
    });
  }
}

for (const includeInitial of [false, true]) {
  for (const outcome of ["failed", "completed"]) {
    test(`monitor never replays timestamp-qualified historical startup backlogs: ${includeInitial}/${outcome}`, async (t) => {
      let injected = false;
      const historical = (id) => ({
        completedAt: 0,
        id,
        items: [],
        status: outcome
      });
      let latest = historical("synthetic-baseline");
      const { connections, requests, socket } = await fixture(
        t,
        ({ message, reply, connections: targets }) => {
          if (message.method === "thread/loaded/list") {
            reply({ data: ["watched"] });
          } else if (message.method === "thread/turns/list") {
            if (!injected) {
              injected = true;
              const [owner] = targets;
              for (const id of [
                "synthetic-older",
                "synthetic-baseline",
                "synthetic-older"
              ]) {
                owner.send(
                  JSON.stringify({
                    method: "turn/completed",
                    params: { threadId: "watched", turn: historical(id) }
                  })
                );
              }
            }
            reply({ data: [latest] });
          } else {
            reply({ thread: { name: null, status: "idle" } });
          }
        }
      );
      const { child, events, exited } = monitor(t, socket, [
        "--include-unnamed",
        ...(includeInitial ? ["--include-initial"] : []),
        "--thread",
        "*"
      ]);
      await t.waitFor(() =>
        assert.ok(requests.some(({ method }) => method === "thread/read"))
      );
      const [owner] = connections;
      owner.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: "active", threadId: "watched" }
        })
      );
      await t.waitFor(() => assert.equal(events.at(-1)?.status, "active"));
      assert.equal(events.length, includeInitial ? 2 : 1);
      assert.ok(events.every(({ event }) => event === "threadStatus"));
      const fresh = {
        completedAt: Math.floor(Date.now() / 1000),
        id: "synthetic-post-launch",
        items:
          outcome === "completed"
            ? [
                {
                  phase: "final_answer",
                  text: "Synthetic current final",
                  type: "agentMessage"
                }
              ]
            : [],
        status: outcome
      };
      for (const turn of [
        historical("synthetic-older"),
        historical("synthetic-baseline"),
        fresh
      ]) {
        owner.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "watched", turn }
          })
        );
      }
      latest = fresh;
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "watched", turn: historical("synthetic-older") }
        })
      );
      owner.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: "idle", threadId: "watched" }
        })
      );
      await t.waitFor(() =>
        assert.deepEqual(
          { event: events.at(-1)?.event, status: events.at(-1)?.status },
          { event: "threadStatus", status: "idle" }
        )
      );
      const terminals = events.filter(({ turnId }) => turnId);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].turnId, fresh.id);
      assert.equal(terminals[0].previous, "active");
      assert.equal(terminals[0].threadName, null);
      assert.equal(
        terminals[0].finalMessage,
        outcome === "completed" ? "Synthetic current final" : null
      );
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      await t.waitFor(() => assert.equal(connections.size, 0));
    });
  }
}

test("monitor backpressure stops notification work and cancellation releases both read-only sockets", async (t) => {
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      reply(
        message.method === "thread/read"
          ? { thread: { status: "active" } }
          : { data: [] }
      );
    }
  );
  const previousSocket = process.env.CODEX_APP_SERVER_SOCKET;
  process.env.CODEX_APP_SERVER_SOCKET = socket;
  const stop = new AbortController();
  const events = [];
  const done = (async () => {
    try {
      await watchThreads({
        emit: async (event, signal) => {
          events.push(event);
          await once(signal, "abort");
        },
        includeInitial: true,
        includeUnnamed: true,
        signal: stop.signal,
        statuses: ["active", "idle", "failed", "systemError"],
        threadIds: ["backpressure"]
      });
    } catch (error) {
      assert.equal(stop.signal.aborted, true, error.message);
    }
  })();
  t.after(async () => {
    stop.abort();
    await done;
    if (previousSocket === undefined) {
      delete process.env.CODEX_APP_SERVER_SOCKET;
    } else {
      process.env.CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });
  await t.waitFor(() => assert.equal(events.length, 1));
  assert.equal(connections.size, 2);
  const reads = requests.length;
  const [owner] = connections;
  for (let count = 0; count < 200; count += 1) {
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: "idle", threadId: "backpressure" }
      })
    );
  }
  await delay(50);
  assert.equal(events.length, 1);
  assert.equal(requests.length, reads);
  stop.abort();
  await done;
  await t.waitFor(() => assert.equal(connections.size, 0));
  assert.equal(events.length, 1);
});

test("monitor reports socket loss as a transport systemError and exits without reconnecting", async (t) => {
  const { connections, socket } = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        name: "Synthetic selection",
        status: { type: "idle" },
        turns: []
      }
    })
  );
  const { events, exited } = monitor(t, socket, [
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events.length, 1), { timeout: 2000 });
  for (const ws of connections) {
    ws.close();
  }
  assert.deepEqual(await exited, [1, null]);
  assert.equal(events.at(-1).event, "transport");
  assert.equal(events.at(-1).status, "systemError");
  assert.equal(events.at(-1).threadId, null);
});

test("monitor validates configuration before connecting and is disabled without watched threads", async (t) => {
  const { requests, socket } = await fixture(t, ({ reply }) => reply({}));
  await Promise.all(
    [
      ["--thread", "watched", "--status", "invalid"],
      ["--thread", "watched", "--timeout-seconds", "0"],
      ["--thread", "watched", "--timeout-seconds", "1801"],
      ["--thread", "watched", "--timeout-seconds", "invalid"]
    ].map(async (args) => {
      const invalid = monitor(t, socket, args);
      assert.deepEqual(await invalid.exited, [1, null]);
      assert.equal(invalid.events.length, 1);
      assert.equal(invalid.events[0].event, "transport");
      assert.equal(invalid.events[0].status, "systemError");
      assert.equal(invalid.events[0].threadId, null);
    })
  );
  const disabled = monitor(t, socket, []);
  assert.deepEqual(await disabled.exited, [0, null]);
  assert.deepEqual(disabled.events, []);
  assert.equal(requests.length, 0);
});

test("explicit notLoaded filtering emits configured snapshots without widening selection", async (t) => {
  const { requests, connections, socket } = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        name: "Synthetic selection",
        status: { type: "notLoaded" },
        turns: []
      }
    })
  );
  const { events, exited } = monitor(
    t,
    socket,
    ["--include-initial", "--status", "notLoaded", "--timeout-seconds", "0.4"],
    {
      CODEX_APP_SERVER_MONITOR_STATUSES: "idle",
      CODEX_APP_SERVER_MONITOR_THREADS: " first, second, "
    }
  );
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(
    events.map((event) => event.threadId),
    ["first", "second"]
  );
  assert.ok(events.every((event) => event.status === "notLoaded"));
  assert.deepEqual(
    [
      ...new Set(
        requests
          .filter((request) => request.method !== "initialize")
          .map((request) => request.params.threadId)
      )
    ],
    ["first", "second"]
  );
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("explicit monitor arguments override environment selection and filters", async (t) => {
  const { requests, connections, socket } = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        name: "Synthetic selection",
        status: { type: "idle" },
        turns: []
      }
    })
  );
  const { events, exited } = monitor(
    t,
    socket,
    [
      "--include-initial",
      "--thread",
      "explicit",
      "--status",
      "idle",
      "--timeout-seconds",
      "0.4"
    ],
    {
      CODEX_APP_SERVER_MONITOR_STATUSES: "invalid",
      CODEX_APP_SERVER_MONITOR_THREADS: "*"
    }
  );
  assert.deepEqual(await exited, [0, null]);
  assert.equal(events.length, 1);
  assert.equal(events[0].threadId, "explicit");
  assert.equal(events[0].status, "idle");
  assert.ok(
    requests.every(
      (request) =>
        request.method === "initialize" ||
        request.params.threadId === "explicit"
    )
  );
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("configured monitor reports an unavailable socket as a genuine startup failure", async (t) => {
  const { socket, requests } = await fixture(t, ({ reply }) => reply({}));
  const { events, exited } = monitor(t, `${socket}.absent`, [
    "--thread",
    "watched"
  ]);
  assert.deepEqual(await exited, [1, null]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "transport");
  assert.equal(events[0].status, "systemError");
  assert.equal(events[0].threadId, null);
  assert.equal(requests.length, 0);
});

test("filtered idle monitor remains quiet until its bounded deadline and closes both sockets", async (t) => {
  const { connections, requests, socket } = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        name: "Synthetic selection",
        status: { type: "idle" },
        turns: []
      }
    })
  );
  const { events, exited } = monitor(t, socket, [
    "--include-initial",
    "--thread",
    "watched",
    "--status",
    "failed",
    "--status",
    "systemError",
    "--timeout-seconds",
    "0.4"
  ]);
  await t.waitFor(() => assert.equal(connections.size, 2), { timeout: 2000 });
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(events, []);
  assert.ok(requests.some((request) => request.method === "thread/read"));
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor deadline cancels a stalled initialize handshake and closes its socket", async (t) => {
  const { connections, socket } = await fixture(t, () => {}, {
    failInitialize: true
  });
  const { events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched",
    "--timeout-seconds",
    "0.1"
  ]);
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(events, []);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor isolates failed thread inspections while other selected threads keep emitting", async (t) => {
  const { socket, connections, requests } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.params?.threadId === "missing") {
        ws.send(
          JSON.stringify({
            error: { code: -32_000, message: "Thread unavailable" },
            id: message.id
          })
        );
      } else if (message.method === "thread/turns/list") {
        reply({ data: [] });
      } else {
        reply({ thread: { status: { type: "idle" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "missing",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.ok(
    events.some(
      (event) => event.event === "inspection" && event.threadId === "missing"
    )
  );
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "active" }, threadId: "watched" }
      })
    );
  }
  await t.waitFor(() => assert.equal(events.at(-1).status, "active"), {
    timeout: 2000
  });
  assert.ok(events.every((event) => event.event !== "transport"));
  for (const entry of requests.filter(
    (request) => request.method === "thread/turns/list"
  )) {
    assert.deepEqual(entry.params, {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: entry.params.threadId
    });
  }
  assert.ok(
    requests
      .filter((request) => request.method === "thread/read")
      .every((request) => request.params.includeTurns === false)
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("monitor drops startup notifications after cancellation", async (t) => {
  const { socket, requests, connections } = await fixture(
    t,
    ({ message, connections: targets }) => {
      if (message.method === "thread/turns/list") {
        for (const type of ["active", "idle"]) {
          for (const ws of targets) {
            ws.send(
              JSON.stringify({
                method: "thread/status/changed",
                params: { status: { type }, threadId: "watched" }
              })
            );
          }
        }
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(
    () =>
      assert.ok(
        requests.some((request) => request.method === "thread/turns/list")
      ),
    { timeout: 2000 }
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(events, []);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialize", "thread/turns/list"]
  );
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("wildcard monitor preserves partial snapshots after a loaded-page refusal", async (t) => {
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/loaded/list" && message.params.cursor) {
        ws.send(
          JSON.stringify({
            error: { code: -32_000, message: "Page unavailable" },
            id: message.id
          })
        );
      } else if (message.method === "thread/loaded/list") {
        reply({ data: ["watched"], nextCursor: "second" });
      } else if (message.method === "thread/turns/list") {
        reply({ data: [] });
      } else {
        reply({ thread: { status: { type: "idle" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*"
  ]);
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.ok(
    events.some(
      (event) => event.event === "inspection" && event.threadId === null
    )
  );
  assert.ok(
    events.some(
      (event) => event.status === "idle" && event.threadId === "watched"
    )
  );
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "active" }, threadId: "later" }
      })
    );
  }
  await t.waitFor(() => assert.equal(events.at(-1)?.threadId, "later"), {
    timeout: 2000
  });
  assert.equal(
    requests.filter((request) => request.method === "thread/loaded/list")
      .length,
    2
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("wildcard monitor stops a repeated cursor while retaining discovered threads", async (t) => {
  const { requests, socket } = await fixture(t, ({ message, reply }) => {
    if (message.method === "thread/loaded/list") {
      reply({ data: ["watched"], nextCursor: "repeated" });
    } else if (message.method === "thread/turns/list") {
      reply({ data: [] });
    } else {
      reply({ thread: { status: { type: "idle" } } });
    }
  });
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*"
  ]);
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.match(
    events.find((event) => event.event === "inspection").error,
    /repeated its cursor/u
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/loaded/list")
      .length,
    2
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/read").length,
    1
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("wildcard monitor cancellation closes a pending later page without inspecting or reconnecting", async (t) => {
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      if (message.method === "thread/loaded/list" && !message.params.cursor) {
        reply({ data: ["watched"], nextCursor: "pending" });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*"
  ]);
  await t.waitFor(
    () =>
      assert.ok(
        requests.some((request) => request.params?.cursor === "pending")
      ),
    { timeout: 2000 }
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(events, []);
  assert.ok(
    requests.every((request) =>
      ["initialize", "thread/loaded/list"].includes(request.method)
    )
  );
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

for (const phase of ["initialize", "thread/resume", "thread/read"]) {
  for (const name of ["codex_send", "codex_steer"]) {
    test(`queued ${name} cancellation during ${phase} prevents late delivery and releases its writer`, async (t) => {
      let original;
      let queued;
      let lateReply;
      let paused = true;
      const turns = [{ id: "active", status: "inProgress" }];
      const delivered = [];
      const { client, connections, requests } = await fixture(
        t,
        ({ message, reply, ws }) => {
          if (message.method === "initialize") {
            original ??= ws;
            if (ws !== original) {
              queued ??= ws;
            }
          }
          const respond = () => {
            if (message.method === "thread/read") {
              reply({ thread: { turns } });
            } else if (message.method === "turn/start") {
              delivered.push(message.params.input[0].text);
              const turn = {
                id: `fresh-${delivered.length}`,
                status: "completed"
              };
              turns.push(turn);
              ws.send(
                JSON.stringify({
                  method: "turn/completed",
                  params: { threadId: "watched", turn }
                })
              );
              reply({ turn });
            } else {
              reply({});
            }
          };
          if (paused && ws === queued && message.method === phase) {
            lateReply = respond;
          } else {
            respond();
          }
        },
        { failInitialize: true }
      );
      const controller = new AbortController();
      const pending = client.callTool(
        {
          arguments: {
            mode: "queue",
            text: "cancelled input",
            thread_id: "watched"
          },
          name
        },
        undefined,
        { signal: controller.signal }
      );
      const rejected = assert.rejects(pending, /Fixture cancellation/u);
      await t.waitFor(() => assert.ok(lateReply), { timeout: 2000 });
      controller.abort(new Error("Fixture cancellation"));
      await rejected;
      await call(client, "codex_queue", { thread_id: "watched" });
      await t.waitFor(() => assert.ok(!connections.has(original)), {
        timeout: 2000
      });
      turns[0].status = "completed";
      paused = false;
      lateReply();
      await t.waitFor(() => assert.equal(connections.size, 0), {
        timeout: 2000
      });
      assert.deepEqual(delivered, []);
      assert.equal(
        requests.filter((request) => request.method === "turn/start").length,
        0
      );
      const receipt = await call(client, "codex_queue", {
        thread_id: "watched"
      });
      assert.ok(
        receipt.value.messages.every(
          (record) => record.status === "refused" && !("text" in record)
        )
      );
      const fresh = await call(client, "codex_send", {
        text: "fresh accepted input",
        thread_id: "watched"
      });
      assert.equal(fresh.error, false);
      assert.equal(fresh.value.status, "started");
      assert.deepEqual(delivered, ["fresh accepted input"]);
      await t.waitFor(() => assert.equal(connections.size, 0), {
        timeout: 2000
      });
    });
  }
}

for (const name of ["codex_send", "codex_steer"]) {
  test(`queued ${name} cancellation preserves acknowledged messages and accepts ordered fresh work`, async (t) => {
    let queueSocket;
    let initializes = 0;
    let paused = false;
    let lateReply;
    const turns = [{ id: "active", status: "inProgress" }];
    const delivered = [];
    const { client, connections, requests } = await fixture(
      t,
      ({ message, reply, ws }) => {
        if (message.method === "initialize") {
          initializes += 1;
          if (initializes === 2) {
            queueSocket = ws;
          }
          reply({});
        } else if (message.method === "thread/read") {
          if (paused && ws === queueSocket) {
            lateReply = () => reply({ thread: { turns } });
          } else {
            reply({ thread: { turns } });
          }
        } else if (message.method === "turn/start") {
          delivered.push(message.params.input[0].text);
          const turn = {
            id: `fresh-${delivered.length}`,
            status: "completed"
          };
          turns.push(turn);
          ws.send(
            JSON.stringify({
              method: "turn/completed",
              params: { threadId: "watched", turn }
            })
          );
          reply({ turn });
        } else {
          reply({});
        }
      },
      { failInitialize: true }
    );
    const first = await call(client, "codex_send", {
      text: "acknowledged first",
      thread_id: "watched"
    });
    assert.equal(first.value.status, "queued");
    paused = true;
    const controller = new AbortController();
    const pending = client.callTool(
      {
        arguments: {
          mode: "queue",
          text: "cancelled input",
          thread_id: "watched"
        },
        name
      },
      undefined,
      { signal: controller.signal }
    );
    const rejected = assert.rejects(pending, /Fixture cancellation/u);
    await t.waitFor(() => assert.ok(lateReply), { timeout: 2000 });
    controller.abort(new Error("Fixture cancellation"));
    await rejected;
    const cancelled = await call(client, "codex_queue", {
      thread_id: "watched"
    });
    const interrupted = await call(client, "codex_interrupt", {
      thread_id: "watched"
    });
    assert.equal(interrupted.error, false);
    assert.equal(interrupted.value.status, "interrupted");
    paused = false;
    lateReply();
    await t.waitFor(() => assert.equal(connections.size, 1), {
      timeout: 2000
    });
    assert.equal(cancelled.value.messages[0].id, first.value.id);
    assert.equal(cancelled.value.messages[0].status, "queued");
    assert.ok(
      cancelled.value.messages
        .slice(1)
        .every((record) => record.status === "refused" && !("text" in record))
    );
    const fresh = await call(client, "codex_send", {
      text: "fresh accepted input",
      thread_id: "watched"
    });
    assert.equal(fresh.error, false);
    assert.equal(fresh.value.status, "queued");
    assert.deepEqual(delivered, []);
    turns[0].status = "completed";
    queueSocket.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "watched", turn: turns[0] }
      })
    );
    await t.waitFor(() => assert.equal(connections.size, 0), {
      timeout: 2000
    });
    assert.deepEqual(delivered, ["acknowledged first", "fresh accepted input"]);
    assert.equal(
      requests.filter((request) => request.method === "turn/start").length,
      2
    );
    const receipt = await call(client, "codex_queue", {
      thread_id: "watched"
    });
    assert.deepEqual(
      receipt.value.messages
        .filter((record) => record.status !== "refused")
        .map((record) => ({ id: record.id, status: record.status })),
      [
        { id: first.value.id, status: "completed" },
        { id: fresh.value.id, status: "completed" }
      ]
    );
  });
}

test("enqueue cancellation preserves a completion wake for acknowledged messages", async (t) => {
  let queueSocket;
  let initializes = 0;
  let paused = false;
  let lateReply;
  const turns = [{ id: "active", status: "inProgress" }];
  const delivered = [];
  const { client, connections } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "initialize") {
        initializes += 1;
        if (initializes === 2) {
          queueSocket = ws;
        }
        reply({});
      } else if (message.method === "thread/read") {
        if (paused && ws === queueSocket) {
          lateReply = () => reply({ thread: { turns } });
        } else {
          reply({ thread: { turns } });
        }
      } else if (message.method === "turn/start") {
        delivered.push(message.params.input[0].text);
        const turn = { id: "fresh", status: "completed" };
        turns.push(turn);
        ws.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "watched", turn }
          })
        );
        reply({ turn });
      } else {
        reply({});
      }
    },
    { failInitialize: true }
  );
  const first = await call(client, "codex_send", {
    text: "acknowledged first",
    thread_id: "watched"
  });
  assert.equal(first.value.status, "queued");
  paused = true;
  const controller = new AbortController();
  const pending = client.callTool(
    {
      arguments: { text: "cancelled input", thread_id: "watched" },
      name: "codex_send"
    },
    undefined,
    { signal: controller.signal }
  );
  const rejected = assert.rejects(pending, /Fixture cancellation/u);
  await t.waitFor(() => assert.ok(lateReply), { timeout: 2000 });
  turns[0].status = "completed";
  queueSocket.send(
    JSON.stringify({
      method: "turn/completed",
      params: { threadId: "watched", turn: turns[0] }
    })
  );
  const pong = once(queueSocket, "pong");
  queueSocket.ping();
  await pong;
  paused = false;
  controller.abort(new Error("Fixture cancellation"));
  await rejected;
  await call(client, "codex_queue", { thread_id: "watched" });
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
  assert.deepEqual(delivered, ["acknowledged first"]);
  lateReply();
  const receipt = await call(client, "codex_queue", { thread_id: "watched" });
  assert.deepEqual(
    receipt.value.messages.map(({ id, status }) => ({ id, status })),
    [{ id: first.value.id, status: "completed" }]
  );
});

for (const name of ["codex_send", "codex_steer"]) {
  test(`queued ${name} cancellation preserves an already-started turn without interruption or retry`, async (t) => {
    let queueSocket;
    let initializes = 0;
    let lateReply;
    const turns = [{ id: "original", status: "inProgress" }];
    const delivered = [];
    const { client, connections, requests } = await fixture(
      t,
      ({ message, reply, ws }) => {
        if (message.method === "initialize") {
          initializes += 1;
          if (initializes === 2) {
            queueSocket = ws;
          }
          reply({});
        } else if (message.method === "thread/read") {
          reply({ thread: { turns } });
        } else if (message.method === "thread/resume") {
          turns[0].status = "completed";
          reply({});
        } else if (message.method === "turn/start") {
          delivered.push(message.params.input[0].text);
          const turn = { id: "started", status: "inProgress" };
          turns.push(turn);
          lateReply = () => reply({ turn });
        } else {
          reply({});
        }
      },
      { failInitialize: true }
    );
    const controller = new AbortController();
    const pending = client.callTool(
      {
        arguments: {
          mode: "queue",
          text: "already started input",
          thread_id: "watched"
        },
        name
      },
      undefined,
      { signal: controller.signal }
    );
    const rejected = assert.rejects(pending, /Fixture cancellation/u);
    await t.waitFor(() => assert.ok(lateReply), { timeout: 2000 });
    controller.abort(new Error("Fixture cancellation"));
    await rejected;
    await call(client, "codex_queue", { thread_id: "watched" });
    lateReply();
    await t.waitFor(
      async () => {
        const receipt = await call(client, "codex_queue", {
          thread_id: "watched"
        });
        assert.equal(receipt.value.messages.length, 1);
        assert.equal(receipt.value.messages[0].status, "started");
        assert.equal(receipt.value.messages[0].turnId, "started");
      },
      { timeout: 2000 }
    );
    assert.ok(connections.has(queueSocket));
    assert.deepEqual(delivered, ["already started input"]);
    assert.ok(!requests.some((request) => request.method === "turn/interrupt"));
    turns[1].status = "completed";
    queueSocket.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "watched", turn: turns[1] }
      })
    );
    await t.waitFor(() => assert.equal(connections.size, 0), {
      timeout: 2000
    });
    const receipt = await call(client, "codex_queue", {
      thread_id: "watched"
    });
    assert.equal(receipt.value.messages[0].status, "completed");
    assert.deepEqual(delivered, ["already started input"]);
    assert.equal(
      requests.filter((request) => request.method === "turn/start").length,
      1
    );
    assert.ok(!requests.some((request) => request.method === "turn/interrupt"));
  });
}

for (const phase of ["initialize", "thread/read"]) {
  for (const name of ["codex_send", "codex_steer", "codex_interrupt"]) {
    test(`curated ${name} cancellation during ${phase} prevents writes and releases its writer`, async (t) => {
      let paused = true;
      let lateReply;
      const { client, connections, requests } = await fixture(
        t,
        ({ message, reply }) => {
          const result =
            message.method === "thread/read"
              ? {
                  thread: {
                    status: { type: "active" },
                    turns: [{ id: "active", status: "inProgress" }]
                  }
                }
              : {};
          if (paused && message.method === phase) {
            lateReply = () => reply(result);
          } else {
            reply(result);
          }
        },
        { failInitialize: phase === "initialize" }
      );
      const controller = new AbortController();
      const pending = client.callTool(
        {
          arguments: {
            mode: "steer",
            text: "Fixture cancelled input",
            thread_id: "watched"
          },
          name
        },
        undefined,
        { signal: controller.signal }
      );
      const rejected = assert.rejects(pending, /Fixture cancellation/u);
      await t.waitFor(() => assert.ok(lateReply), { timeout: 2000 });
      controller.abort(new Error("Fixture cancellation"));
      await rejected;
      await t.waitFor(() => assert.equal(connections.size, 0), {
        timeout: 2000
      });
      lateReply();
      assert.ok(
        requests.every((request) =>
          ["initialize", "thread/read"].includes(request.method)
        )
      );
      const receipt = await call(client, "codex_queue", {
        thread_id: "watched"
      });
      assert.deepEqual(receipt.value.messages, []);
      paused = false;
      const fresh = await call(client, "codex_interrupt", {
        thread_id: "watched"
      });
      assert.equal(fresh.error, false);
      assert.equal(fresh.value.status, "interrupted");
    });
  }
}

test("monitor deduplicates newer idle inspection failures against buffered older completions", async (t) => {
  const error = { code: "model_not_found", message: "Fixture model is absent" };
  let inspections = 0;
  const { connections, socket } = await fixture(
    t,
    ({ message, reply, connections: targets }) => {
      if (message.method === "thread/loaded/list") {
        reply({ data: ["watched"] });
      } else if (message.method === "thread/turns/list") {
        inspections += 1;
        if (inspections === 2) {
          const [owner] = targets;
          for (const id of ["failure-a", "failure-b"]) {
            owner.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "watched",
                  turn: { error, id, status: "failed" }
                }
              })
            );
          }
          owner.send(
            JSON.stringify({
              method: "thread/status/changed",
              params: { status: { type: "active" }, threadId: "sentinel" }
            })
          );
          reply({ data: [{ error, id: "failure-b", status: "failed" }] });
        } else {
          reply({ data: [] });
        }
      } else {
        reply({ thread: { status: { type: "active" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*"
  ]);
  await t.waitFor(() => assert.equal(events[0]?.status, "active"));
  const [owner] = connections;
  owner.send(
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "watched",
        turn: { error, id: "failure-a", status: "failed" }
      }
    })
  );
  await t.waitFor(() =>
    assert.equal(
      events.filter((event) => event.event === "turnError").length,
      1
    )
  );
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "watched" }
    })
  );
  await t.waitFor(() => assert.equal(events.at(-1)?.threadId, "sentinel"));
  assert.deepEqual(
    events
      .filter((event) => event.event === "turnError")
      .map((event) => event.turnId),
    ["failure-a", "failure-b"]
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0));
});

test("monitor falls back to thread/read turns when paginated turns are unsupported", async (t) => {
  let status = "active";
  let turn = { id: "initial", status: "inProgress" };
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/turns/list") {
        ws.send(
          JSON.stringify({
            error: {
              code: -32_601,
              message: "paginated_threads is not supported yet"
            },
            id: message.id
          })
        );
      } else {
        reply({
          thread: {
            status: { type: status },
            ...(message.params.includeTurns ? { turns: [turn] } : {})
          }
        });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events[0]?.status, "active"), {
    timeout: 2000
  });
  assert.ok(
    requests.some(
      (request) =>
        request.method === "thread/read" && request.params.includeTurns === true
    )
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/turns/list").length,
    1
  );
  assert.ok(events.every((event) => event.event === "threadStatus"));
  const notify = (type) => {
    for (const ws of connections) {
      ws.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: { type }, threadId: "watched" }
        })
      );
    }
  };
  status = "idle";
  turn = {
    error: { message: "fixture failure" },
    id: "initial",
    status: "failed"
  };
  notify("idle");
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  assert.deepEqual(
    events.map((event) => [event.event, event.status]),
    [
      ["threadStatus", "active"],
      ["turnError", "failed"],
      ["threadStatus", "idle"]
    ]
  );
  assert.equal(events[1].turnId, "initial");
  assert.equal(events[1].error.message, "fixture failure");
  notify("idle");
  await delay(50);
  assert.equal(events.length, 3);
  assert.equal(
    requests.filter((request) => request.method === "thread/turns/list").length,
    1
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor emits one capability notice when no supported turn read exists", async (t) => {
  const { connections, socket } = await fixture(t, ({ message, reply, ws }) => {
    const turnRead =
      message.method === "thread/turns/list" ||
      (message.method === "thread/read" &&
        message.params.includeTurns === true);
    if (turnRead) {
      ws.send(
        JSON.stringify({
          error: { code: -32_601, message: "not supported yet" },
          id: message.id
        })
      );
    } else {
      reply({ thread: { status: { type: "idle" } } });
    }
  });
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched",
    "--status",
    "idle",
    "--status",
    "failed"
  ]);
  await t.waitFor(
    () =>
      assert.equal(
        events.filter((event) => event.event === "capability").length,
        1
      ),
    { timeout: 2000 }
  );
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: "watched" }
      })
    );
  }
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.equal(events[0].event, "threadStatus");
  assert.equal(events[0].status, "idle");
  assert.equal(events[0].previous, null);
  assert.equal(events[1].event, "capability");
  assert.equal(events[1].status, "systemError");
  assert.equal(events[1].threadId, null);
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: "watched" }
      })
    );
  }
  await delay(50);
  assert.equal(events.length, 2);
  const [owner] = connections;
  owner.send(
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "watched",
        turn: {
          error: { message: "fixture failure" },
          id: "later",
          status: "failed"
        }
      }
    })
  );
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  assert.equal(events.at(-1).event, "turnError");
  assert.equal(events.at(-1).turnId, "later");
  assert.ok(events.every((event) => event.event !== "inspection"));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor reports a status-read failure refused after unsupported turn reads", async (t) => {
  const { connections, socket } = await fixture(t, ({ message, ws }) => {
    if (message.method === "thread/turns/list") {
      ws.send(
        JSON.stringify({
          error: {
            code: -32_601,
            message: "paginated_threads is not supported yet"
          },
          id: message.id
        })
      );
    } else if (
      message.method === "thread/read" &&
      message.params.includeTurns === true
    ) {
      ws.send(
        JSON.stringify({
          error: { code: -32_601, message: "not supported yet" },
          id: message.id
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          error: { code: -32_000, message: "Thread unavailable" },
          id: message.id
        })
      );
    }
  });
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.equal(events[0].event, "inspection");
  assert.equal(events[0].status, "systemError");
  assert.equal(events[0].threadId, "watched");
  assert.match(events[0].error, /Thread unavailable/u);
  assert.equal(events[1].event, "capability");
  assert.equal(events[1].status, "systemError");
  assert.equal(events[1].threadId, null);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor retries an empty-rollout thread on its next status change", async (t) => {
  let empty = true;
  let turn = { id: "initial", status: "inProgress" };
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/turns/list") {
        if (empty) {
          ws.send(
            JSON.stringify({
              error: {
                code: -32_603,
                message: "failed to read thread: ... rollout ... is empty"
              },
              id: message.id
            })
          );
        } else {
          reply({ data: [turn] });
        }
      } else {
        reply({ thread: { status: { type: "active" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(
    () =>
      assert.ok(
        requests.some((request) => request.method === "thread/turns/list")
      ),
    { timeout: 2000 }
  );
  await t.waitFor(() => assert.equal(events.length, 1), { timeout: 2000 });
  assert.deepEqual(events[0], {
    event: "threadStatus",
    previous: null,
    status: "active",
    threadId: "watched",
    threadName: null
  });
  const notify = () => {
    for (const ws of connections) {
      ws.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: { type: "active" }, threadId: "watched" }
        })
      );
    }
  };
  notify();
  await delay(50);
  assert.equal(events.length, 1);
  empty = false;
  turn = {
    error: { message: "fixture failure" },
    id: "initial",
    status: "failed"
  };
  notify();
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.equal(events[1].event, "turnError");
  assert.equal(events[1].turnId, "initial");
  assert.ok(events.every((event) => event.event !== "inspection"));
  assert.ok(events.every((event) => event.event !== "capability"));
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/read" &&
        request.params.includeTurns === false
    ).length,
    2
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor falls back per thread while other threads keep paginated turns", async (t) => {
  const error = { message: "fixture failure" };
  const turns = new Map([
    ["legacy", [{ error, id: "legacy-failure", status: "failed" }]],
    ["paginated", [{ error, id: "paginated-failure", status: "failed" }]]
  ]);
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/turns/list") {
        if (message.params.threadId === "legacy") {
          ws.send(
            JSON.stringify({
              error: {
                code: -32_601,
                message: "paginated_threads is not supported yet"
              },
              id: message.id
            })
          );
        } else {
          reply({ data: turns.get("paginated") });
        }
      } else {
        reply({
          thread: {
            status: { type: "idle" },
            ...(message.params.includeTurns
              ? { turns: turns.get("legacy") }
              : {})
          }
        });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "legacy",
    "--thread",
    "paginated"
  ]);
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.deepEqual(
    events
      .filter((event) => event.event === "threadStatus")
      .map((event) => [event.threadId, event.status, event.previous]),
    [
      ["legacy", "idle", null],
      ["paginated", "idle", null]
    ]
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === "turnError")
      .map((event) => event.turnId),
    []
  );
  assert.ok(events.every((event) => event.event !== "inspection"));
  assert.ok(events.every((event) => event.event !== "capability"));
  assert.ok(
    requests
      .filter(
        (request) =>
          request.method === "thread/read" &&
          request.params.includeTurns === true
      )
      .every((request) => request.params.threadId === "legacy")
  );
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/turns/list" &&
        request.params.threadId === "paginated"
    ).length,
    1
  );
  const [owner] = connections;
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "paginated" }
    })
  );
  owner.send(
    JSON.stringify({
      method: "thread/status/changed",
      params: { status: { type: "idle" }, threadId: "legacy" }
    })
  );
  await delay(50);
  assert.equal(events.length, 2);
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/turns/list" &&
        request.params.threadId === "paginated"
    ).length,
    2
  );
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/turns/list" &&
        request.params.threadId === "legacy"
    ).length,
    1
  );
  assert.ok(
    requests
      .filter(
        (request) =>
          request.method === "thread/read" &&
          request.params.includeTurns === true
      )
      .every((request) => request.params.threadId === "legacy")
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor retries a not-materialized thread on its next status change", async (t) => {
  let materialized = false;
  const turn = {
    error: { message: "fixture failure" },
    id: "first",
    status: "failed"
  };
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/turns/list") {
        if (materialized) {
          reply({ data: [turn] });
        } else {
          ws.send(
            JSON.stringify({
              error: {
                code: -32_600,
                message:
                  "thread watched is not materialized yet; thread/turns/list is unavailable before first user message"
              },
              id: message.id
            })
          );
        }
      } else {
        reply({ thread: { status: { type: "active" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() => assert.equal(events.length, 1), { timeout: 2000 });
  assert.deepEqual(events[0], {
    event: "threadStatus",
    previous: null,
    status: "active",
    threadId: "watched",
    threadName: null
  });
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/read" &&
        request.params.includeTurns === false
    ).length,
    1
  );
  materialized = true;
  for (const ws of connections) {
    ws.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: "watched" }
      })
    );
  }
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  assert.equal(events[1].event, "turnError");
  assert.equal(events[1].turnId, "first");
  assert.equal(events[2].status, "idle");
  assert.ok(events.every((event) => event.event !== "inspection"));
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "thread/read" &&
        request.params.includeTurns === false
    ).length,
    3
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor keeps startup snapshots after a refused turn read and no redundant retry reads", async (t) => {
  let empty = true;
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/turns/list") {
        if (empty) {
          ws.send(
            JSON.stringify({
              error: {
                code: -32_603,
                message: "failed to read thread: ... rollout ... is empty"
              },
              id: message.id
            })
          );
        } else {
          reply({
            data: [
              {
                error: { message: "fixture failure" },
                id: "initial",
                status: "failed"
              }
            ]
          });
        }
      } else {
        reply({ thread: { status: { type: "idle" } } });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched"
  ]);
  await t.waitFor(
    () =>
      assert.ok(
        events.some(
          (event) =>
            event.event === "threadStatus" &&
            event.previous === null &&
            event.status === "idle"
        )
      ),
    { timeout: 2000 }
  );
  const statusReads = () =>
    requests.filter(
      (request) =>
        request.method === "thread/read" &&
        request.params.includeTurns === false
    ).length;
  assert.equal(statusReads(), 1);
  const notify = (type) => {
    for (const ws of connections) {
      ws.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: { type }, threadId: "watched" }
        })
      );
    }
  };
  notify("active");
  await delay(50);
  assert.equal(statusReads(), 2);
  assert.deepEqual(
    events.filter((event) => event.event === "threadStatus"),
    [
      {
        event: "threadStatus",
        previous: null,
        status: "idle",
        threadId: "watched",
        threadName: null
      },
      {
        event: "threadStatus",
        previous: "idle",
        status: "active",
        threadId: "watched",
        threadName: null
      }
    ]
  );
  empty = false;
  notify("notLoaded");
  await delay(100);
  assert.ok(
    !events.some((event) => event.event === "turnError"),
    "notLoaded must clear the deferred retry"
  );
  assert.equal(
    events.filter((event) => event.event === "threadStatus").length,
    2
  );
  notify("idle");
  await t.waitFor(
    () =>
      assert.ok(
        events.some(
          (event) => event.event === "turnError" && event.turnId === "initial"
        )
      ),
    { timeout: 2000 }
  );
  assert.equal(statusReads(), 3);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor bounds deferred threads and drops the oldest entry past the cap", async (t) => {
  const refusing = new Set(["oldest"]);
  const turnRequests = [];
  const { connections, socket } = await fixture(t, ({ message, reply, ws }) => {
    if (message.method === "thread/loaded/list") {
      reply({ data: ["oldest"] });
    } else if (message.method === "thread/turns/list") {
      turnRequests.push(message.params.threadId);
      if (refusing.has(message.params.threadId)) {
        ws.send(
          JSON.stringify({
            error: {
              code: -32_603,
              message: "failed to read thread: ... rollout ... is empty"
            },
            id: message.id
          })
        );
      } else {
        reply({ data: [] });
      }
    } else {
      reply({ thread: { status: { type: "idle" } } });
    }
  });
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "*"
  ]);
  await t.waitFor(() => assert.ok(turnRequests.includes("oldest")), {
    timeout: 2000
  });
  const notify = (threadId, type) => {
    for (const ws of connections) {
      ws.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: { type }, threadId }
        })
      );
    }
  };
  for (let count = 0; count < 128; count += 1) {
    refusing.add(`bulk-${count}`);
    notify(`bulk-${count}`, "idle");
  }
  await t.waitFor(() => assert.ok(turnRequests.includes("bulk-127")), {
    timeout: 2000
  });
  notify("oldest", "active");
  await delay(100);
  assert.equal(turnRequests.filter((id) => id === "oldest").length, 1);
  notify("bulk-0", "active");
  await t.waitFor(
    () => assert.equal(turnRequests.filter((id) => id === "bulk-0").length, 2),
    { timeout: 2000 }
  );
  notify("oldest", "idle");
  await t.waitFor(
    () => assert.equal(turnRequests.filter((id) => id === "oldest").length, 2),
    { timeout: 2000 }
  );
  assert.ok(events.every((event) => event.event !== "inspection"));
  assert.ok(events.every((event) => event.event !== "capability"));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("monitor drops a deferred thread when it leaves daemon memory", async (t) => {
  let refused = true;
  const turnRequests = [];
  const { connections, socket } = await fixture(t, ({ message, reply, ws }) => {
    if (message.method === "thread/turns/list") {
      turnRequests.push(message.params.threadId);
      if (refused) {
        ws.send(
          JSON.stringify({
            error: {
              code: -32_603,
              message: "failed to read thread: ... rollout ... is empty"
            },
            id: message.id
          })
        );
      } else {
        reply({ data: [] });
      }
    } else {
      reply({ thread: { status: { type: "idle" } } });
    }
  });
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--include-initial",
    "--thread",
    "watched",
    "--status",
    "idle",
    "--status",
    "active",
    "--status",
    "notLoaded"
  ]);
  await t.waitFor(() => assert.equal(events[0]?.status, "idle"), {
    timeout: 2000
  });
  assert.equal(turnRequests.length, 1);
  const notify = (type) => {
    for (const ws of connections) {
      ws.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: { type }, threadId: "watched" }
        })
      );
    }
  };
  notify("notLoaded");
  await t.waitFor(() => assert.equal(events.length, 2), { timeout: 2000 });
  assert.equal(events[1].status, "notLoaded");
  refused = false;
  notify("active");
  await delay(100);
  assert.equal(events.length, 2);
  assert.equal(turnRequests.length, 1);
  notify("idle");
  await t.waitFor(() => assert.equal(turnRequests.length, 2), {
    timeout: 2000
  });
  await t.waitFor(() => assert.equal(events.length, 3), { timeout: 2000 });
  assert.equal(events[2].previous, "active");
  assert.equal(events[2].status, "idle");
  assert.ok(events.every((event) => event.event !== "inspection"));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0), { timeout: 2000 });
});

test("default wildcard monitor silently baselines history and emits named post-launch transitions and terminals", async (t) => {
  let name = "Synthetic initial name";
  let turn = { id: "old-failure", itemsView: "notLoaded", status: "failed" };
  const final = "Synthetic final answer\n".repeat(10_000);
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply }) => {
      if (message.method === "thread/loaded/list") {
        reply(
          message.params.cursor
            ? { data: ["second"] }
            : { data: ["watched"], nextCursor: "next" }
        );
      } else if (message.method === "thread/read") {
        reply({ thread: { name, status: "idle" } });
      } else if (message.method === "thread/items/list") {
        reply(
          message.params.cursor
            ? {
                data: [
                  {
                    item: {
                      phase: "final_answer",
                      text: final,
                      type: "agentMessage"
                    },
                    turnId: message.params.turnId
                  },
                  {
                    item: {
                      phase: "final_answer",
                      text: "Synthetic unrelated turn",
                      type: "agentMessage"
                    },
                    turnId: "unrelated"
                  }
                ]
              }
            : {
                data: [
                  {
                    item: {
                      phase: "commentary",
                      text: "Synthetic progress",
                      type: "agentMessage"
                    },
                    turnId: message.params.turnId
                  }
                ],
                nextCursor: "last"
              }
        );
      } else {
        reply({ data: [turn] });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, ["--thread", "*"]);
  await t.waitFor(() =>
    assert.equal(
      requests.filter(({ method }) => method === "thread/read").length,
      2
    )
  );
  await delay(30);
  assert.deepEqual(events, []);
  const [owner] = connections;
  const status = (threadId, type) =>
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: { type }, threadId }
      })
    );
  status("watched", "idle");
  status("watched", "active");
  await t.waitFor(() => assert.equal(events.length, 1));
  assert.equal(events[0].previous, "idle");
  assert.equal(events[0].threadName, name);
  name = "Synthetic renamed thread";
  turn = {
    id: "fresh-completion",
    itemsView: "notLoaded",
    status: "completed"
  };
  status("watched", "idle");
  await t.waitFor(() => assert.equal(events.length, 3));
  assert.equal(events[1].event, "turnCompleted");
  assert.equal(events[1].turnId, "fresh-completion");
  assert.equal(events[1].turnStatus, "completed");
  assert.equal(events[1].finalMessage, final);
  assert.equal(events[1].threadName, name);
  status("watched", "idle");
  turn = { id: "old-failure", itemsView: "notLoaded", status: "failed" };
  status("watched", "idle");
  status("new-thread", "active");
  await delay(30);
  assert.equal(events.length, 3);
  turn = { id: "fresh-failure", items: [], status: "failed" };
  status("new-thread", "idle");
  await t.waitFor(() => assert.equal(events.length, 5));
  assert.equal(events[3].event, "turnError");
  assert.equal(events[3].previous, "active");
  assert.equal(events[3].finalMessage, null);
  assert.equal(events[4].threadId, "new-thread");
  assert.ok(!events.some(({ turnId }) => turnId === "old-failure"));
  assert.ok(
    requests
      .filter(({ method }) => method === "thread/items/list")
      .every(({ params }) => params.turnId === "fresh-completion")
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0));
});

for (const includeUnnamed of [false, true]) {
  for (const includeInitial of [false, true]) {
    for (const includeNotLoaded of [false, true]) {
      for (const includePreviousNotLoaded of [false, true]) {
        test(`wildcard monitor selects name, previous, and current categories independently: ${includeUnnamed}/${includeInitial}/${includeNotLoaded}/${includePreviousNotLoaded}`, async (t) => {
          const { connections, requests, socket } = await fixture(
            t,
            ({ message, reply }) =>
              reply(
                message.method === "thread/read"
                  ? {
                      thread: {
                        name:
                          message.params.threadId === "sentinel"
                            ? "Synthetic sentinel"
                            : null
                      }
                    }
                  : { data: [] }
              )
          );
          const args = [
            ...(includeUnnamed ? ["--include-unnamed"] : []),
            "--thread",
            "*"
          ];
          if (includeInitial) {
            args.push("--include-initial");
          }
          if (includePreviousNotLoaded) {
            args.push("--include-previous-not-loaded");
          }
          if (includeNotLoaded) {
            args.push(
              "--status",
              "active",
              "--status",
              "idle",
              "--status",
              "notLoaded"
            );
          }
          const { child, events, exited } = monitor(t, socket, args);
          await t.waitFor(() =>
            assert.ok(
              requests.some(({ method }) => method === "thread/loaded/list")
            )
          );
          const [owner] = connections;
          for (const type of [
            "active",
            "notLoaded",
            "idle",
            "notLoaded",
            "active",
            "idle",
            "idle"
          ]) {
            owner.send(
              JSON.stringify({
                method: "thread/status/changed",
                params: { status: { type }, threadId: "new-thread" }
              })
            );
          }
          for (const type of ["active", "idle"]) {
            owner.send(
              JSON.stringify({
                method: "thread/status/changed",
                params: { status: type, threadId: "sentinel" }
              })
            );
          }
          const expected = includeUnnamed
            ? [
                ...(includeInitial
                  ? [{ previous: null, status: "active" }]
                  : []),
                ...(includeNotLoaded
                  ? [{ previous: "active", status: "notLoaded" }]
                  : []),
                ...(includePreviousNotLoaded
                  ? [{ previous: "notLoaded", status: "idle" }]
                  : []),
                ...(includeNotLoaded
                  ? [{ previous: "idle", status: "notLoaded" }]
                  : []),
                ...(includePreviousNotLoaded
                  ? [{ previous: "notLoaded", status: "active" }]
                  : []),
                { previous: "active", status: "idle" }
              ]
            : [];
          await t.waitFor(() =>
            assert.equal(
              events.filter(({ threadId }) => threadId === "sentinel").length,
              includeInitial ? 2 : 1
            )
          );
          child.kill("SIGTERM");
          assert.deepEqual(await exited, [0, null]);
          assert.deepEqual(
            events
              .filter(({ threadId }) => threadId !== "sentinel")
              .map(({ previous, status }) => ({ previous, status })),
            expected
          );
          assert.ok(
            events
              .filter(({ threadId }) => threadId !== "sentinel")
              .every(({ threadName }) => threadName === null)
          );
          await t.waitFor(() => assert.equal(connections.size, 0));
        });
      }
    }
  }
}

for (const includeInitial of [false, true]) {
  test(`monitor preserves concurrent fresh failures through inspector initialization and later baselines: ${includeInitial}`, async (t) => {
    let initializes = 0;
    const fresh = {
      id: "racing-failure",
      items: [
        {
          phase: "commentary",
          text: "Synthetic progress",
          type: "agentMessage"
        }
      ],
      status: "failed"
    };
    const { connections, socket } = await fixture(
      t,
      ({ message, reply, connections: targets }) => {
        if (message.method === "initialize") {
          initializes += 1;
          if (initializes === 2) {
            const [owner] = targets;
            owner.send(
              JSON.stringify({
                method: "thread/status/changed",
                params: { status: "active", threadId: "watched" }
              })
            );
            owner.send(
              JSON.stringify({
                method: "turn/completed",
                params: { threadId: "watched", turn: fresh }
              })
            );
            setTimeout(() => reply({}), 30);
          } else {
            reply({});
          }
        } else if (message.method === "thread/turns/list") {
          reply({ data: [fresh] });
        } else {
          reply({ thread: { name: "Synthetic race", status: "active" } });
        }
      },
      { failInitialize: true }
    );
    const { child, events, exited } = monitor(t, socket, [
      ...(includeInitial ? ["--include-initial"] : []),
      "--thread",
      "watched"
    ]);
    await t.waitFor(() => assert.equal(events.length, includeInitial ? 2 : 1));
    assert.equal(events.at(-1).event, "turnError");
    assert.equal(events.at(-1).turnId, fresh.id);
    assert.equal(events.at(-1).previous, "active");
    assert.equal(events.at(-1).threadName, "Synthetic race");
    assert.equal(events.at(-1).finalMessage, null);
    const [owner] = connections;
    owner.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "watched", turn: fresh }
      })
    );
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: "idle", threadId: "watched" }
      })
    );
    await t.waitFor(() => assert.equal(events.at(-1).status, "idle"));
    assert.equal(events.filter(({ event }) => event === "turnError").length, 1);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    await t.waitFor(() => assert.equal(connections.size, 0));
  });
}

for (const includeInitial of [false, true]) {
  for (const outcome of ["failed", "completed"]) {
    for (const race of [
      "active-idle",
      "idle-only",
      "idle-read",
      "historical"
    ]) {
      test(`monitor correlates status-only startup terminals with native baselines: ${includeInitial}/${outcome}/${race}`, async (t) => {
        let initializes = 0;
        const fresh = {
          ...(race === "historical" ? { completedAt: 0 } : {}),
          id: "synthetic-startup-turn",
          items:
            outcome === "completed"
              ? [
                  {
                    phase: "final_answer",
                    text: "Synthetic startup final",
                    type: "agentMessage"
                  }
                ]
              : [],
          status: outcome
        };
        const { connections, socket } = await fixture(
          t,
          ({ message, reply, connections: targets }) => {
            if (message.method === "initialize") {
              initializes += 1;
              if (initializes === 2 && race !== "idle-read") {
                const [owner] = targets;
                for (const status of race === "idle-only"
                  ? ["idle"]
                  : ["active", "idle"]) {
                  owner.send(
                    JSON.stringify({
                      method: "thread/status/changed",
                      params: { status, threadId: "watched" }
                    })
                  );
                }
                setTimeout(() => reply({}), 30);
              } else {
                reply({});
              }
            } else if (message.method === "thread/loaded/list") {
              reply({ data: ["watched"] });
            } else if (message.method === "thread/turns/list") {
              reply({ data: [fresh] });
            } else {
              const result = {
                thread: {
                  name: "Synthetic startup name",
                  status: ["idle-only", "idle-read"].includes(race)
                    ? "active"
                    : "idle"
                }
              };
              if (race === "idle-read" && !message.params.includeTurns) {
                const [owner] = targets;
                owner.send(
                  JSON.stringify({
                    method: "thread/status/changed",
                    params: { status: "idle", threadId: "watched" }
                  })
                );
                setTimeout(() => reply(result), 30);
              } else {
                reply(result);
              }
            }
          },
          { failInitialize: true }
        );
        const { child, events, exited } = monitor(t, socket, [
          ...(includeInitial ? ["--include-initial"] : []),
          "--thread",
          "*"
        ]);
        await t.waitFor(() =>
          assert.ok(
            events.some(
              ({ event, status, previous }) =>
                event === "threadStatus" &&
                status === "idle" &&
                previous === "active"
            )
          )
        );
        const terminals = events.filter(({ turnId }) => turnId === fresh.id);
        assert.equal(terminals.length, race === "historical" ? 0 : 1);
        if (race !== "historical") {
          assert.equal(
            terminals[0].event,
            outcome === "failed" ? "turnError" : "turnCompleted"
          );
          assert.equal(terminals[0].previous, "active");
          assert.equal(terminals[0].threadName, "Synthetic startup name");
          assert.equal(
            terminals[0].finalMessage,
            outcome === "completed" ? "Synthetic startup final" : null
          );
        }
        assert.equal(
          events.filter(({ previous }) => previous === null).length,
          includeInitial ? 1 : 0
        );
        const [owner] = connections;
        owner.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "watched", turn: fresh }
          })
        );
        owner.send(
          JSON.stringify({
            method: "thread/status/changed",
            params: { status: "idle", threadId: "watched" }
          })
        );
        const next = {
          ...fresh,
          completedAt: undefined,
          id: "synthetic-distinct-turn"
        };
        owner.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "watched", turn: next }
          })
        );
        await t.waitFor(() => assert.equal(events.at(-1).turnId, next.id));
        assert.equal(
          events.filter(({ turnId }) => turnId === fresh.id).length,
          race === "historical" ? 0 : 1
        );
        child.kill("SIGTERM");
        assert.deepEqual(await exited, [0, null]);
        await t.waitFor(() => assert.equal(connections.size, 0));
      });
    }
  }
}

test("terminal enrichment correlates exact turns and diagnoses missing history without substituting progress or stale finals", async (t) => {
  let missing = false;
  const { connections, requests, socket } = await fixture(
    t,
    ({ message, reply, ws }) => {
      if (message.method === "thread/items/list") {
        ws.send(
          JSON.stringify({
            error: { code: -32_601, message: "Synthetic unsupported items" },
            id: message.id
          })
        );
      } else if (message.method === "thread/turns/list") {
        reply({ data: [] });
      } else {
        reply({
          thread: {
            name: null,
            status: "active",
            turns: [
              {
                id: "stale",
                items: [
                  {
                    phase: "final_answer",
                    text: "Synthetic stale final",
                    type: "agentMessage"
                  }
                ],
                status: "completed"
              },
              ...(missing
                ? []
                : [
                    {
                      id: "correlated",
                      items: [
                        {
                          phase: "commentary",
                          text: "Synthetic progress",
                          type: "agentMessage"
                        },
                        {
                          phase: "final_answer",
                          text: "Synthetic corresponding final",
                          type: "agentMessage"
                        },
                        {
                          phase: "partial_answer",
                          text: "Synthetic partial",
                          type: "agentMessage"
                        }
                      ],
                      status: "completed"
                    }
                  ])
            ]
          }
        });
      }
    }
  );
  const { child, events, exited } = monitor(t, socket, [
    "--include-unnamed",
    "--thread",
    "watched"
  ]);
  await t.waitFor(() =>
    assert.ok(requests.some(({ method }) => method === "thread/read"))
  );
  const [owner] = connections;
  const terminal = (turn) =>
    owner.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "watched", turn }
      })
    );
  terminal({ id: "correlated", itemsView: "notLoaded", status: "completed" });
  await t.waitFor(() => assert.equal(events.length, 1));
  assert.equal(events[0].finalMessage, "Synthetic corresponding final");
  assert.equal(events[0].threadName, null);
  missing = true;
  terminal({
    error: { message: "Synthetic failure" },
    id: "missing",
    itemsView: "notLoaded",
    status: "failed"
  });
  await t.waitFor(() => assert.equal(events.length, 2));
  assert.equal(events[1].event, "turnError");
  assert.equal(events[1].finalMessage, null);
  assert.match(events[1].enrichmentError, /unavailable/u);
  terminal({
    id: "no-final",
    items: [
      { phase: "commentary", text: "Synthetic progress", type: "agentMessage" }
    ],
    status: "completed"
  });
  await t.waitFor(() => assert.equal(events.length, 3));
  assert.equal(events[2].finalMessage, null);
  assert.ok(
    events.every(({ finalMessage }) => finalMessage !== "Synthetic stale final")
  );
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await t.waitFor(() => assert.equal(connections.size, 0));
});

for (const phase of ["thread/items/list", "thread/read"]) {
  test(`monitor deadline cancels terminal enrichment during ${phase} and releases both sockets`, async (t) => {
    let metadataReads = 0;
    let stalled = false;
    const { connections, requests, socket } = await fixture(
      t,
      ({ message, reply }) => {
        if (message.method === "thread/read") {
          metadataReads += 1;
        }
        if (
          message.method === phase &&
          (phase !== "thread/read" || metadataReads > 1)
        ) {
          stalled = true;
        } else {
          reply(
            message.method === "thread/read"
              ? { thread: { status: "active" } }
              : { data: [] }
          );
        }
      }
    );
    const { events, exited } = monitor(t, socket, [
      "--include-unnamed",
      "--thread",
      "watched",
      "--timeout-seconds",
      "0.6"
    ]);
    await t.waitFor(() =>
      assert.ok(requests.some(({ method }) => method === "thread/read"))
    );
    const [owner] = connections;
    owner.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "watched",
          turn: {
            id: "pending-enrichment",
            status: "completed",
            ...(phase === "thread/read"
              ? {
                  items: [
                    {
                      phase: "final_answer",
                      text: "Synthetic final",
                      type: "agentMessage"
                    }
                  ]
                }
              : { itemsView: "notLoaded" })
          }
        }
      })
    );
    await t.waitFor(() => assert.equal(stalled, true));
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(events, []);
    await t.waitFor(() => assert.equal(connections.size, 0));
  });
}

for (const includeInitial of [false, true]) {
  for (const turnStatus of ["failed", "completed"]) {
    test(`monitor never replays historical ${turnStatus} notifications after an idle inspection: ${includeInitial}`, async (t) => {
      const historical = {
        id: "historical-terminal",
        items: [],
        status: turnStatus
      };
      const { connections, requests, socket } = await fixture(
        t,
        ({ message, reply }) =>
          reply(
            message.method === "thread/read"
              ? { thread: { name: "Synthetic history", status: "idle" } }
              : { data: [historical] }
          )
      );
      const { child, events, exited } = monitor(t, socket, [
        ...(includeInitial ? ["--include-initial"] : []),
        "--thread",
        "watched"
      ]);
      await t.waitFor(() =>
        assert.ok(requests.some(({ method }) => method === "thread/read"))
      );
      const [owner] = connections;
      owner.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: "idle", threadId: "watched" }
        })
      );
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "watched", turn: historical }
        })
      );
      owner.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: "systemError", threadId: "watched" }
        })
      );
      await t.waitFor(() => assert.equal(events.at(-1)?.status, "systemError"));
      assert.ok(events.every(({ turnId }) => turnId !== historical.id));
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "watched",
            turn: { ...historical, id: "genuinely-distinct-terminal" }
          }
        })
      );
      await t.waitFor(() =>
        assert.equal(events.at(-1)?.turnId, "genuinely-distinct-terminal")
      );
      assert.equal(events.at(-1).finalMessage, null);
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      await t.waitFor(() => assert.equal(connections.size, 0));
    });
  }
}

for (const includeInitial of [false, true]) {
  for (const secondRaces of [false, true]) {
    test(`monitor keeps unaffected baselines and captures buffered cross-thread startup events: ${includeInitial}/${secondRaces}`, async (t) => {
      let injected = false;
      const { connections, requests, socket } = await fixture(
        t,
        ({ message, reply, connections: targets }) => {
          if (message.method === "thread/loaded/list") {
            reply({ data: ["first", "second"] });
          } else if (message.method === "thread/read") {
            if (!injected && message.params.threadId === "first") {
              injected = true;
              const [owner] = targets;
              owner.send(
                JSON.stringify({
                  method: "thread/status/changed",
                  params: { status: "active", threadId: "first" }
                })
              );
              if (secondRaces) {
                owner.send(
                  JSON.stringify({
                    method: "thread/status/changed",
                    params: { status: "active", threadId: "second" }
                  })
                );
              }
              setTimeout(() => reply({ thread: { status: "active" } }), 30);
            } else {
              reply({ thread: { status: "active" } });
            }
          } else {
            reply({ data: [] });
          }
        }
      );
      const { child, events, exited } = monitor(t, socket, [
        "--include-unnamed",
        ...(includeInitial ? ["--include-initial"] : []),
        "--thread",
        "*"
      ]);
      await t.waitFor(() =>
        assert.ok(
          requests.some(
            ({ method, params }) =>
              method === "thread/read" && params.threadId === "second"
          )
        )
      );
      await delay(30);
      const [owner] = connections;
      const fresh = { id: "second-fresh-failure", items: [], status: "failed" };
      owner.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "second", turn: fresh }
        })
      );
      owner.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { status: "idle", threadId: "second" }
        })
      );
      await t.waitFor(() => assert.equal(events.at(-1)?.status, "idle"));
      assert.ok(
        events.some(
          ({ turnId, previous }) => turnId === fresh.id && previous === "active"
        )
      );
      if (includeInitial) {
        assert.equal(
          events.filter(
            ({ threadId, status }) =>
              threadId === "second" && status === "active"
          ).length,
          1
        );
        if (secondRaces) {
          assert.deepEqual(
            events
              .filter(({ status }) => status === "active")
              .map(({ threadId }) => threadId),
            ["first", "second"]
          );
        }
      } else {
        assert.ok(events.every(({ previous }) => previous !== null));
      }
      assert.equal(events.at(-1).previous, "active");
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      await t.waitFor(() => assert.equal(connections.size, 0));
    });
  }
}

for (const selection of ["explicit", "wildcard"]) {
  for (const includeUnnamed of [false, true]) {
    test(`monitor preserves named events and selects unnamed threads explicitly: ${selection}/${includeUnnamed}`, async (t) => {
      let unnamedName = null;
      const { connections, requests, socket } = await fixture(
        t,
        ({ message, reply }) => {
          if (message.method === "thread/loaded/list") {
            reply(
              message.params.cursor
                ? { data: ["unnamed"], nextCursor: null }
                : { data: ["named"], nextCursor: "synthetic-page" }
            );
          } else if (message.method === "thread/read") {
            reply({
              thread: {
                name:
                  message.params.threadId === "named"
                    ? "Synthetic Main"
                    : unnamedName,
                status: "active"
              }
            });
          } else {
            reply({
              data: [{ completedAt: 0, id: "old-failure", status: "failed" }]
            });
          }
        }
      );
      const { child, events, exited } = monitor(t, socket, [
        ...(includeUnnamed ? ["--include-unnamed"] : []),
        "--thread",
        selection === "wildcard" ? "*" : "named",
        ...(selection === "explicit" ? ["--thread", "unnamed"] : [])
      ]);
      await t.waitFor(() =>
        assert.equal(
          requests.filter(({ method }) => method === "thread/read").length,
          2
        )
      );
      await delay(30);
      assert.deepEqual(events, []);
      const [owner] = connections;
      const notify = (threadId, method, params) =>
        owner.send(JSON.stringify({ method, params: { ...params, threadId } }));
      const complete = (threadId, id, status) =>
        notify(threadId, "turn/completed", {
          turn: {
            id,
            status,
            ...(status === "failed"
              ? {
                  error: {
                    code: "model_not_found",
                    message: "Synthetic model failure"
                  }
                }
              : {}),
            items: [
              {
                phase: "commentary",
                text: "Synthetic progress",
                type: "agentMessage"
              },
              ...(status === "completed"
                ? [
                    {
                      phase: "final_answer",
                      text: `Synthetic final ${id}`,
                      type: "agentMessage"
                    }
                  ]
                : [])
            ]
          }
        });
      for (const threadId of ["named", "unnamed"]) {
        complete(threadId, "completed", "completed");
        notify(threadId, "thread/status/changed", { status: "idle" });
        complete(threadId, "failure", "failed");
        complete(threadId, "failure", "failed");
        notify(threadId, "thread/status/changed", { status: "systemError" });
      }
      await t.waitFor(() =>
        assert.equal(events.length, includeUnnamed ? 8 : 4)
      );
      assert.equal(
        events.filter(({ threadId }) => threadId === "unnamed").length,
        includeUnnamed ? 4 : 0
      );
      for (const event of events) {
        assert.equal(
          event.threadName,
          event.threadId === "named" ? "Synthetic Main" : null
        );
        if (event.event === "turnCompleted") {
          assert.equal(event.finalMessage, "Synthetic final completed");
          assert.equal(event.previous, "active");
        } else if (event.event === "turnError") {
          assert.equal(event.finalMessage, null);
          assert.equal(event.error.code, "model_not_found");
        }
      }
      const retained = events.length;
      unnamedName = "Synthetic renamed Main";
      complete("unnamed", "failure", "failed");
      notify("unnamed", "thread/status/changed", { status: "systemError" });
      notify("unnamed", "thread/status/changed", { status: "active" });
      complete("unnamed", "after-rename", "completed");
      notify("unnamed", "thread/status/changed", { status: "idle" });
      await t.waitFor(() => assert.equal(events.length, retained + 3));
      assert.deepEqual(
        events.slice(retained).map(({ event }) => event),
        ["threadStatus", "turnCompleted", "threadStatus"]
      );
      assert.ok(
        events
          .slice(retained)
          .every(({ threadName }) => threadName === unnamedName)
      );
      assert.equal(events.at(-2).finalMessage, "Synthetic final after-rename");
      unnamedName = null;
      notify("unnamed", "thread/status/changed", { status: "active" });
      complete("unnamed", "after-removal", "completed");
      notify("unnamed", "thread/status/changed", { status: "idle" });
      notify("named", "thread/status/changed", { status: "active" });
      await t.waitFor(() =>
        assert.equal(events.length, retained + 4 + (includeUnnamed ? 3 : 0))
      );
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      assert.ok(
        events
          .slice(retained + 3, -1)
          .every(({ threadName }) => threadName === null)
      );
      assert.equal(
        events.slice(retained + 3, -1).length,
        includeUnnamed ? 3 : 0
      );
      await t.waitFor(() => assert.equal(connections.size, 0));
    });
  }
}

for (const name of [undefined, "", "   "]) {
  test(`monitor excludes missing or blank names without reading terminal messages: ${JSON.stringify(name)}`, async (t) => {
    let nameReads = 0;
    const { connections, requests, socket } = await fixture(
      t,
      ({ message, reply }) => {
        if (message.method === "thread/read") {
          nameReads += 1;
          reply({ thread: { name, status: "active" } });
        } else {
          reply({ data: [] });
        }
      }
    );
    const { child, events, exited } = monitor(t, socket, [
      "--thread",
      "watched"
    ]);
    await t.waitFor(() => assert.equal(nameReads, 1));
    const [owner] = connections;
    owner.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "watched",
          turn: {
            id: "unnamed-terminal",
            itemsView: "notLoaded",
            status: "completed"
          }
        }
      })
    );
    await t.waitFor(() => assert.equal(nameReads, 2));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(events, []);
    assert.ok(!requests.some(({ method }) => method === "thread/items/list"));
    await t.waitFor(() => assert.equal(connections.size, 0));
  });
}

for (const includeUnnamed of [false, true]) {
  test(`monitor reports name-read failures honestly and retains native errors: ${includeUnnamed}`, async (t) => {
    let nameReads = 0;
    const nativeError = {
      code: "model_not_found",
      message: "Synthetic model failure"
    };
    const { connections, requests, socket } = await fixture(
      t,
      ({ message, reply, ws }) => {
        if (message.method === "thread/read") {
          nameReads += 1;
          if (nameReads === 1) {
            reply({
              thread: { name: "Synthetic initial name", status: "active" }
            });
          } else {
            ws.send(
              JSON.stringify({
                error: { code: -32_000, message: "Synthetic metadata refusal" },
                id: message.id
              })
            );
          }
        } else {
          reply({ data: [] });
        }
      }
    );
    const { child, events, exited } = monitor(t, socket, [
      ...(includeUnnamed ? ["--include-unnamed"] : []),
      "--thread",
      "watched",
      "--status",
      "failed"
    ]);
    await t.waitFor(() => assert.equal(nameReads, 1));
    const [owner] = connections;
    owner.send(
      JSON.stringify({
        method: "error",
        params: {
          error: nativeError,
          threadId: "watched",
          turnId: "name-read-failure",
          willRetry: false
        }
      })
    );
    await t.waitFor(() => assert.equal(events.length, 1));
    assert.equal(events[0].threadName, null);
    assert.equal(events[0].turnId, "name-read-failure");
    if (includeUnnamed) {
      assert.equal(events[0].event, "turnError");
      assert.equal(events[0].finalMessage, null);
      assert.deepEqual(events[0].error, nativeError);
      assert.match(events[0].enrichmentError, /Synthetic metadata refusal/u);
    } else {
      assert.equal(events[0].event, "inspection");
      assert.equal(events[0].status, "systemError");
      assert.equal(events[0].sourceEvent, "turnError");
      assert.deepEqual(events[0].nativeError, nativeError);
      assert.match(events[0].error, /Synthetic metadata refusal/u);
      assert.ok(!requests.some(({ method }) => method === "thread/items/list"));
    }
    owner.send(
      JSON.stringify({
        method: "error",
        params: {
          error: nativeError,
          threadId: "watched",
          turnId: "name-read-failure",
          willRetry: false
        }
      })
    );
    owner.send(
      JSON.stringify({
        method: "thread/status/changed",
        params: { status: "idle", threadId: "watched" }
      })
    );
    await t.waitFor(() =>
      assert.equal(
        requests.filter(({ method }) => method === "thread/turns/list").length,
        2
      )
    );
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    assert.equal(events.length, 1);
    await t.waitFor(() => assert.equal(connections.size, 0));
  });
}
