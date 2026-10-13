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
 * Silently baseline existing work and output configured, enriched events one at a time.
 */
export const watchThreads = async ({
  emit,
  includeInitial = false,
  signal,
  statuses,
  threadIds
}) => {
  const client = await openClient({ signal });
  const initialized = Promise.withResolvers();
  const startup = { notified: new Set(), ready: false };
  const observeNotification = (note) => {
    if (
      !["thread/status/changed", "turn/completed", "error"].includes(
        note.method
      )
    ) {
      return;
    }
    const threadId = note.params?.threadId;
    if (
      !threadId ||
      !(threadIds.includes("*") || threadIds.includes(threadId))
    ) {
      return;
    }
    if (note.method === "error" && note.params.willRetry) {
      return;
    }
    const initial = !startup.ready;
    if (initial) {
      startup.notified.add(threadId);
    }
    return initial;
  };
  const notification = async (note, notificationInitial) => {
    if (notificationInitial === undefined) {
      return;
    }
    const handle = await initialized.promise;
    await handle?.(note, notificationInitial);
  };
  const unsubscribe = client.listenNotifications(
    notification,
    observeNotification
  );
  let inspector;
  try {
    inspector = await openClient({
      signal: AbortSignal.any([signal, client.signal])
    });
  } catch (error) {
    unsubscribe();
    initialized.resolve();
    client.close();
    throw error;
  }
  const waiting = AbortSignal.any([signal, client.signal, inspector.signal]);
  const ended = once(waiting, "abort");
  const output = async (event) => {
    if (event.previous === null && !includeInitial) {
      return;
    }
    let threadName = event.threadName ?? null;
    let enrichmentError;
    if (event.threadId && !Object.hasOwn(event, "threadName")) {
      try {
        const { thread } = await inspector.request("thread/read", {
          includeTurns: false,
          threadId: event.threadId
        });
        threadName = thread.name ?? null;
      } catch (error) {
        if (waiting.aborted) {
          throw error;
        }
        enrichmentError = error.message;
      }
    }
    await emit(
      {
        ...event,
        threadName,
        ...(enrichmentError
          ? {
              enrichmentError: [event.enrichmentError, enrichmentError]
                .filter(Boolean)
                .join("; ")
            }
          : {})
      },
      waiting
    );
  };
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
  const turnItems = async (threadId, turnId) => {
    const items = [];
    const cursors = new Set();
    const page = async (cursor) => {
      const result = await inspector.request("thread/items/list", {
        ...(cursor ? { cursor } : {}),
        threadId,
        turnId
      });
      items.push(
        ...(result.data ?? [])
          .filter((entry) => entry.turnId === turnId)
          .map((entry) => entry.item)
      );
      const next = result.nextCursor;
      if (next && cursors.has(next)) {
        throw new Error("Turn-item pagination repeated its cursor");
      }
      if (next && !waiting.aborted) {
        cursors.add(next);
        await page(next);
      }
    };
    try {
      await page();
      return items;
    } catch (error) {
      if (!methodNotSupported(error) || waiting.aborted) {
        throw error;
      }
      const { thread } = await inspector.request("thread/read", {
        includeTurns: true,
        threadId
      });
      const matching = thread.turns?.find(({ id }) => id === turnId);
      if (!matching) {
        throw new Error("Completed turn is unavailable in thread history", {
          cause: error
        });
      }
      return matching.items ?? [];
    }
  };
  const finalMessage = async (threadId, turn) => {
    try {
      if (typeof turn.id !== "string") {
        throw new TypeError("Terminal notification has no turn ID");
      }
      const items =
        Array.isArray(turn.items) &&
        !["notLoaded", "summary"].includes(turn.itemsView)
          ? turn.items
          : await turnItems(threadId, turn.id);
      return {
        finalMessage:
          items.findLast(
            (item) =>
              item.type === "agentMessage" && item.phase === "final_answer"
          )?.text ?? null
      };
    } catch (error) {
      if (waiting.aborted) {
        throw error;
      }
      return { enrichmentError: error.message, finalMessage: null };
    }
  };
  const rememberTerminal = (
    threadId,
    turn,
    initial,
    inspection,
    notificationInitial
  ) => {
    const seen = failures.get(threadId) ?? {};
    const identifiers = [seen.inspection, seen.latest];
    if (initial || inspection || !notificationInitial || seen.initialObserved) {
      identifiers.push(seen.initial);
    }
    const identified = typeof turn.id === "string";
    const key = `${turn.id}:${turn.status}`;
    const repeated = identified && identifiers.includes(key);
    if (identified && (!repeated || initial)) {
      const observed = inspection ? "inspection" : "latest";
      const source = initial ? "initial" : observed;
      const retained =
        source === "latest" && seen.initial === key ? {} : { [source]: key };
      const initialObserved =
        seen.initialObserved || (!initial && seen.initial === key);
      failures.set(threadId, { ...seen, ...retained, initialObserved });
    }
    return repeated;
  };
  const terminal = async (
    threadId,
    turn,
    { initial = false, inspection = false, notificationInitial = false } = {}
  ) => {
    if (!["failed", "completed", "interrupted"].includes(turn?.status)) {
      return;
    }
    const repeated = rememberTerminal(
      threadId,
      turn,
      initial,
      inspection,
      notificationInitial
    );
    const status = turn.status === "failed" ? "failed" : "idle";
    const previous = current.get(threadId) ?? null;
    if (
      initial ||
      repeated ||
      !statuses.includes(status) ||
      (previous === null && !includeInitial)
    ) {
      return;
    }
    const details = await finalMessage(threadId, turn);
    await output({
      ...(turn.error ? { error: turn.error } : {}),
      ...details,
      event: turn.status === "failed" ? "turnError" : "turnCompleted",
      previous,
      status,
      threadId,
      turnId: turn.id ?? null,
      turnStatus: turn.status
    });
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
    if (!startup.notified.has(threadId)) {
      const status = thread.status?.type ?? thread.status ?? "notLoaded";
      if (includeInitial) {
        await transition(threadId, status, { threadName: thread.name ?? null });
      } else {
        current.set(threadId, status);
      }
    }
  };
  const inspect = async (threadId, initial = false) => {
    pending.delete(threadId);
    let turnRejected = null;
    try {
      const latest = await latestTurn(threadId);
      await terminal(threadId, latest, {
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
    const withoutTurnRead =
      turnRejected !== null &&
      turnReadRefused.has(threadId) &&
      methodNotSupported(turnRejected) &&
      !waiting.aborted &&
      !signal.aborted;
    if (withoutTurnRead && rejected !== turnRejected) {
      await inspectionError(threadId, rejected);
      await capabilityNotice();
      return;
    }
    if (withoutTurnRead) {
      await capabilityNotice();
      return;
    }
    await inspectionError(threadId, rejected);
  };
  const handle = async (note, notificationInitial) => {
    const threadId = note.params?.threadId;
    if (waiting.aborted || !threadId || !selected(threadId)) {
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
      await terminal(threadId, note.params.turn, { notificationInitial });
    } else if (note.method === "error" && !note.params.willRetry) {
      await terminal(
        threadId,
        {
          error: note.params.error,
          id: note.params.turnId,
          status: "failed"
        },
        { notificationInitial }
      );
    }
  };
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
      startup.ready = true;
      initialized.resolve(handle);
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
