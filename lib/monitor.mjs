import { once } from "node:events";

import { openClient } from "./connection.mjs";

const MAX_PENDING = 128;

/** Detect a method-not-supported rejection for the requested read. */
const methodNotSupported = (error) => /"code":-32601/u.test(error.message);

/** Detect a transient rejection for a thread whose rollout file has no content yet. */
const emptyRollout = (error) =>
  /"code":-32603/u.test(error.message) &&
  /"message":"[^]*rollout[^]*is empty/iu.test(error.message);

/** Detect a transient rejection for a thread whose history is not materialized yet. */
const notMaterialized = (error) =>
  /"code":-32600/u.test(error.message) &&
  /"message":"[^]*not materialized/iu.test(error.message);

/** Detect a transient turn-read rejection that a later inspection may resolve. */
const transientRead = (error) => emptyRollout(error) || notMaterialized(error);

/**
 * Watch native thread status broadcasts without resuming threads or claiming a writer.
 * Output only configured transitions and terminal failures, one structured event at a time.
 */
export const watchThreads = async ({ emit, signal, statuses, threadIds }) => {
  const client = await openClient({ signal });
  // Inspections use a separate read-only socket so paused event intake cannot block their responses.
  let inspector;
  try {
    inspector = await openClient({
      signal: AbortSignal.any([signal, client.signal])
    });
  } catch (error) {
    client.close();
    throw error;
  }
  const initialized = Promise.withResolvers();
  const waiting = AbortSignal.any([signal, client.signal, inspector.signal]);
  const ended = once(waiting, "abort");
  const output = (event) => emit(event, waiting);
  const current = new Map();
  const failures = new Map();
  const pending = new Set();
  const turnReadRefused = new Set();
  const capability = { noticed: false };
  const selected = (threadId) =>
    threadIds.includes("*") || threadIds.includes(threadId);
  const transition = async (threadId, status, extra = {}) => {
    const previous = current.get(threadId) ?? null;
    if (previous === status) {
      return;
    }
    current.set(threadId, status);
    if (statuses.includes(status)) {
      await output({
        ...extra,
        event: "threadStatus",
        previous,
        status,
        threadId
      });
    }
  };
  const terminalFailure = async (
    threadId,
    turn,
    { initial = false, inspection = false } = {}
  ) => {
    const seen = failures.get(threadId);
    if (turn?.status === "failed") {
      const repeated =
        seen && [seen.initial, seen.inspection, seen.latest].includes(turn.id);
      if (!repeated || inspection) {
        failures.set(threadId, {
          initial: initial ? turn.id : seen?.initial,
          inspection: inspection ? turn.id : seen?.inspection,
          latest: inspection ? seen?.latest : turn.id
        });
      }
      if (!repeated && statuses.includes("failed")) {
        await output({
          ...(turn.error ? { error: turn.error } : {}),
          event: "turnError",
          previous: current.get(threadId) ?? null,
          status: "failed",
          threadId,
          turnId: turn.id
        });
      }
    }
  };
  const inspectionError = async (threadId, error) => {
    if (waiting.aborted) {
      throw error;
    }
    if (!signal.aborted) {
      await output({
        error: error.message,
        event: "inspection",
        status: "systemError",
        threadId
      });
    }
  };
  const capabilityNotice = async () => {
    if (!capability.noticed && !signal.aborted && !waiting.aborted) {
      capability.noticed = true;
      await output({
        error:
          "no supported turn read: thread/turns/list and thread/read with turn history are both refused",
        event: "capability",
        status: "systemError",
        threadId: null
      });
    }
  };
  const latestTurn = async (threadId) => {
    if (!turnReadRefused.has(threadId)) {
      try {
        const page = await inspector.request("thread/turns/list", {
          itemsView: "notLoaded",
          limit: 1,
          sortDirection: "desc",
          threadId
        });
        return page.data?.[0];
      } catch (error) {
        if (waiting.aborted || signal.aborted || !methodNotSupported(error)) {
          throw error;
        }
        turnReadRefused.add(threadId);
      }
    }
    const { thread } = await inspector.request("thread/read", {
      includeTurns: true,
      threadId
    });
    return (thread.turns ?? []).at(-1);
  };
  const snapshotStatus = async (threadId) => {
    const { thread } = await inspector.request("thread/read", {
      includeTurns: false,
      threadId
    });
    await transition(
      threadId,
      thread.status?.type ?? thread.status ?? "notLoaded"
    );
  };
  const inspect = async (threadId, initial = false) => {
    pending.delete(threadId);
    let turnRejected = null;
    try {
      const latest = await latestTurn(threadId);
      await terminalFailure(threadId, latest, {
        initial,
        inspection: true
      });
    } catch (error) {
      turnRejected = error;
    }
    let statusRejected = null;
    if (initial) {
      try {
        await snapshotStatus(threadId);
      } catch (error) {
        statusRejected = error;
      }
    }
    const rejected = statusRejected ?? turnRejected;
    if (!rejected) {
      return;
    }
    if (transientRead(rejected) && !waiting.aborted && !signal.aborted) {
      pending.add(threadId);
      if (pending.size > MAX_PENDING) {
        pending.delete(pending.keys().next().value);
      }
      return;
    }
    if (
      turnRejected &&
      turnReadRefused.has(threadId) &&
      methodNotSupported(turnRejected) &&
      !waiting.aborted &&
      !signal.aborted
    ) {
      await capabilityNotice();
      return;
    }
    await inspectionError(threadId, rejected);
  };
  const handle = async (note) => {
    const threadId = note.params?.threadId;
    if (!threadId || !selected(threadId)) {
      return;
    }
    if (note.method === "thread/status/changed") {
      const status = note.params.status?.type ?? note.params.status;
      if (status === "notLoaded") {
        pending.delete(threadId);
      } else if (status === "idle" || pending.delete(threadId)) {
        await inspect(threadId);
      }
      await transition(threadId, status);
    } else if (note.method === "turn/completed") {
      await terminalFailure(threadId, note.params.turn);
    } else if (note.method === "error" && !note.params.willRetry) {
      await terminalFailure(threadId, {
        error: note.params.error,
        id: note.params.turnId,
        status: "failed"
      });
    }
  };
  const notification = async (note) => {
    if (
      !["thread/status/changed", "turn/completed", "error"].includes(
        note.method
      )
    ) {
      return;
    }
    await initialized.promise;
    if (!waiting.aborted) {
      await handle(note);
    }
  };
  const unsubscribe = client.listenNotifications(notification);
  try {
    if (!waiting.aborted) {
      let ids = threadIds;
      if (threadIds.includes("*")) {
        ids = [];
        try {
          const cursors = new Set();
          const page = async (cursor) => {
            const loaded = await inspector.request(
              "thread/loaded/list",
              cursor ? { cursor } : {}
            );
            ids.push(...(loaded.data ?? []));
            const next = loaded.nextCursor;
            if (next && cursors.has(next)) {
              throw new Error("Loaded-thread pagination repeated its cursor");
            }
            if (next && !waiting.aborted) {
              cursors.add(next);
              await page(next);
            }
          };
          await page();
        } catch (error) {
          await inspectionError(null, error);
        }
      }
      for await (const threadId of new Set(ids)) {
        if (waiting.aborted) {
          break;
        }
        await inspect(threadId, true);
      }
      initialized.resolve();
      if (!waiting.aborted) {
        await ended;
      }
    }
    if (client.signal.aborted || inspector.signal.aborted) {
      throw client.signal.reason ?? inspector.signal.reason;
    }
  } finally {
    unsubscribe();
    initialized.resolve();
    client.close();
    inspector.close();
  }
};
