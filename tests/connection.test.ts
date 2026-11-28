import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { openClient } from "../lib/connection.ts";

const verifyStalledUpgrade: (
  t: import("node:test").TestContext,
  cancel: boolean
) => Promise<void> = async (t, cancel) => {
  const directory = await mkdtemp("/tmp/local-upgrade-");
  const server = createServer();
  const controller = new AbortController();
  const previousSocket = process.env.CODEX_APP_SERVER_SOCKET;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  t.after(async () => {
    controller.abort();
    if (!cancel) {
      t.mock.timers.reset();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await server[Symbol.asyncDispose]();
    await rm(directory, { force: true, recursive: true });
    if (previousSocket === undefined) {
      delete process.env.CODEX_APP_SERVER_SOCKET;
    } else {
      process.env.CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });
  const socketPath = path.join(directory, "socket");
  server.listen(socketPath);
  await once(server, "listening", { signal: t.signal });
  process.env.CODEX_APP_SERVER_SOCKET = socketPath;
  const reason = new Error("Caller cancelled the connection");
  if (!cancel) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  }
  const connection = openClient({ signal: controller.signal });
  const [, socket] = (await once(server, "upgrade", {
    signal: t.signal
  })) as unknown[];
  assert.ok(socket instanceof Socket);
  const closed = once(socket, "close", { signal: t.signal });
  socket.once("end", () => {
    socket.end();
  });
  socket.resume();
  if (cancel) {
    controller.abort(reason);
  } else {
    t.mock.timers.tick(5000);
  }
  await Promise.all([
    closed,
    assert.rejects(connection, (error) =>
      cancel ? error === reason : error instanceof Error
    )
  ]);
};

await test(
  "a stalled WebSocket upgrade times out and closes its socket",
  { timeout: 8000 },
  async (t) => {
    await verifyStalledUpgrade(t, false);
  }
);

await test(
  "caller cancellation rejects a pending WebSocket upgrade and closes its socket",
  { timeout: 3000 },
  async (t) => {
    await verifyStalledUpgrade(t, true);
  }
);
