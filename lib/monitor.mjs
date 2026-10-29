import { once } from "node:events";

import { z } from "zod";

import { openClient } from "./connection.mjs";
import {
  nativeItem,
  nativeNotification,
  nativeTurn,
  threadRead
} from "./native-schema.mjs";

const MAX_PENDING = 128;
const nativeError = z.looseObject({ message: z.string() });
const turnPage = z.looseObject({ data: z.array(nativeTurn).nullish() });
const itemPage = z.looseObject({
  data: z
    .array(z.looseObject({ item: nativeItem, turnId: z.string() }))
    .nullish(),
  nextCursor: z.string().nullish()
});
const loadedPage = z.looseObject({
  data: z.array(z.string()).nullish(),
  nextCursor: z.string().nullish()
});
/**
 * @typedef {Record<string, unknown> & {event: string, threadId: string | null, threadName?: string | null, turnId?: string | null, enrichmentError?: string, error?: unknown}} MonitorEvent
 */

/** @param {unknown} error - Native request failure. */
const errorMessage = (error) => {
  const result = nativeError.safeParse(error);
  return result.success ? result.data.message : "";
};

/**
 * Detect a method-not-supported rejection for the requested read.
 * @param {unknown} error - Native request failure.
 */
const methodNotSupported = (error) =>
  /"code":-32601/u.test(errorMessage(error));

/**
 * Detect a transient rejection for a thread whose rollout file has no content yet.
 * @param {unknown} error - Native request failure.
 */
const emptyRollout = (error) =>
  /"code":-32603/u.test(errorMessage(error)) &&
  /"message":"[^]*rollout[^]*is empty/iu.test(errorMessage(error));

/**
 * Detect a transient rejection for a thread whose history is not materialized yet.
 * @param {unknown} error - Native request failure.
 */
const notMaterialized = (error) =>
  /"code":-32600/u.test(errorMessage(error)) &&
  /"message":"[^]*not materialized/iu.test(errorMessage(error));

/**
 * Detect a transient turn-read rejection that a later inspection may resolve.
 * @param {unknown} error - Native request failure.
 */
const transientRead = (error) => emptyRollout(error) || notMaterialized(error);

/**
 * Determine whether native completion timing establishes a pre-launch turn.
 * @param {z.infer<typeof nativeTurn>} turn - Native turn.
 * @param {number} startedAt - Monitor start time in seconds.
 */
const historicalTurn = (turn, startedAt) =>
  typeof turn.completedAt === "number" && turn.completedAt < startedAt;

/**
 * Watch native thread status broadcasts without resuming threads or claiming a writer.
 * Silently baseline existing work and output configured, enriched events one at a time.
 * @param {{emit: (event: Record<string, unknown>, signal: AbortSignal) => Promise<void>, includeInitial?: boolean, includePreviousNotLoaded?: boolean, includeUnnamed?: boolean, signal: AbortSignal, statuses: string[], threadIds: string[]}} options - Monitor configuration.
 */
export const watchThreads = async ({
  emit,
  includeInitial = false,
  includePreviousNotLoaded = false,
  includeUnnamed = false,
  signal,
  statuses,
  threadIds
}) => {
  const startedAt = Math.floor(Date.now() / 1000);
  /** @type {Map<string, string | null | undefined>} */
  const notified = new Map();
  const startup = { notified, ready: false };
  /** @type {[z.infer<typeof nativeNotification>, boolean][]} */
  const pendingNotifications = [];
  /** @type {PromiseWithResolvers<((note: z.infer<typeof nativeNotification>, initial: boolean) => Promise<void>) | undefined>} */
  const initialized = Promise.withResolvers();
  let clientReady = false;
  /**
   * @param {object} message - Native notification candidate.
   * @returns {boolean | undefined} Startup status for selected notifications.
   */
  const observeNotification = (message) => {
    const parsed = nativeNotification.safeParse(message);
    /** @type {boolean | undefined} */
    let initial;
    if (parsed.success) {
      const note = parsed.data;
      const threadId = note.params?.threadId;
      if (
        ["thread/status/changed", "turn/completed", "error"].includes(
          note.method
        ) &&
        threadId !== undefined &&
        threadId !== "" &&
        (threadIds.includes("*") || threadIds.includes(threadId)) &&
        !(note.method === "error" && note.params.willRetry === true)
      ) {
        initial = !startup.ready;
        if (initial && (startup.notified.get(threadId) ?? "") === "") {
          let status = null;
          if (note.method === "thread/status/changed") {
            status =
              typeof note.params.status === "string"
                ? note.params.status
                : note.params.status?.type;
          }
          startup.notified.set(threadId, status);
        }
      }
    }
    return initial;
  };
  const notification = async (message, notificationInitial) => {
    const parsed = nativeNotification.safeParse(message);
    if (parsed.success && typeof notificationInitial === "boolean") {
      const note = parsed.data;
      if (clientReady) {
        const handle = await initialized.promise;
        await handle?.(note, notificationInitial);
      } else {
        pendingNotifications.push([note, notificationInitial]);
      }
    }
  };
  const client = await openClient({
    observeNotification,
    onNotification: notification,
    signal
  });
  clientReady = true;
  let inspector;
  try {
    inspector = await openClient({
      signal: AbortSignal.any([signal, client.signal])
    });
  } catch (error) {
    initialized.resolve();
    client.close();
    throw error;
  }
  const waiting = AbortSignal.any([signal, client.signal, inspector.signal]);
  const ended = once(waiting, "abort");
  /** @param {{previous: string | null, status: string | undefined}} state - Thread status transition. */
  const observable = ({ previous, status }) =>
    (previous !== null || includeInitial) &&
    (previous !== "notLoaded" ||
      includePreviousNotLoaded ||
      status === "failed" ||
      status === "systemError");
  /** @type {Map<string, string | undefined>} */
  const current = new Map();
  /** @type {Map<string, {initial?: string, latest?: string, inspection?: string, initialObserved?: boolean, initialHistorical?: boolean}>} */
  const failures = new Map();
  /** @type {Set<string>} */
  const pending = new Set();
  /** @type {Set<string>} */
  const turnReadRefused = new Set();
  const capability = { noticed: false };
  /** @param {string} threadId - Thread identifier. */
  const selected = (threadId) =>
    threadIds.includes("*") || threadIds.includes(threadId);
  /**
   * @param {string} threadId - Thread identifier.
   * @param {string} turnId - Turn identifier.
   */
  const turnItems = async (threadId, turnId) => {
    /** @type {z.infer<typeof nativeItem>[]} */
    let items = [];
    /** @type {Set<string>} */
    const cursors = new Set();
    /** @param {string} [cursor] - Page cursor. */
    const page = async (cursor) => {
      const result = itemPage.parse(
        await inspector.request("thread/items/list", {
          ...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
          threadId,
          turnId
        })
      );
      items.push(
        ...(result.data ?? [])
          .filter((entry) => entry.turnId === turnId)
          .map((entry) => entry.item)
      );
      const next = result.nextCursor;
      if (
        next !== null &&
        next !== undefined &&
        next !== "" &&
        cursors.has(next)
      ) {
        throw new Error("Turn-item pagination repeated its cursor");
      }
      if (
        next !== null &&
        next !== undefined &&
        next !== "" &&
        !waiting.aborted
      ) {
        cursors.add(next);
        await page(next);
      }
    };
    try {
      await page();
    } catch (error) {
      if (!methodNotSupported(error) || waiting.aborted) {
        throw error;
      }
      const { thread } = threadRead.parse(
        await inspector.request("thread/read", { includeTurns: true, threadId })
      );
      const matching = thread.turns?.find(({ id }) => id === turnId);
      if (!matching) {
        throw new Error("Completed turn is unavailable in thread history", {
          cause: error
        });
      }
      items = matching.items ?? [];
    }
    return items;
  };
  /**
   * @param {string} threadId - Thread identifier.
   * @param {z.infer<typeof nativeTurn>} turn - Native turn.
   */
  const finalMessage = async (threadId, turn) => {
    let result;
    try {
      if (typeof turn.id !== "string") {
        throw new TypeError("Terminal notification has no turn ID");
      }
      const items =
        Array.isArray(turn.items) &&
        !["notLoaded", "summary"].includes(turn.itemsView)
          ? turn.items
          : await turnItems(threadId, turn.id);
      result = {
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
      result = { enrichmentError: errorMessage(error), finalMessage: null };
    }
    return result;
  };
  /**
   * @param {MonitorEvent} event - Monitor event.
   * @param {z.infer<typeof nativeTurn>} [turn] - Terminal turn.
   */
  const output = async (event, turn) => {
    let threadName = event.threadName ?? null;
    let enrichmentError;
    if (
      event.threadId !== null &&
      event.threadId !== "" &&
      !Object.hasOwn(event, "threadName")
    ) {
      try {
        const { thread } = threadRead.parse(
          await inspector.request("thread/read", {
            includeTurns: false,
            threadId: event.threadId
          })
        );
        threadName = thread.name ?? null;
      } catch (error) {
        if (waiting.aborted) {
          throw error;
        }
        enrichmentError = errorMessage(error);
      }
    }
    if (
      includeUnnamed ||
      (typeof threadName === "string" && threadName.trim().length > 0) ||
      ["inspection", "capability"].includes(event.event)
    ) {
      const details =
        turn && event.threadId !== null
          ? await finalMessage(event.threadId, turn)
          : {};
      await emit(
        {
          ...event,
          ...details,
          threadName,
          ...(enrichmentError !== undefined && enrichmentError !== ""
            ? {
                enrichmentError: [
                  details.enrichmentError,
                  event.enrichmentError,
                  enrichmentError
                ]
                  .filter(Boolean)
                  .join("; ")
              }
            : {})
        },
        waiting
      );
    } else if (enrichmentError !== undefined && enrichmentError !== "") {
      await emit(
        {
          error: enrichmentError,
          event: "inspection",
          ...(event.error === undefined ? {} : { nativeError: event.error }),
          sourceEvent: event.event,
          status: "systemError",
          threadId: event.threadId,
          threadName: null,
          ...(turn ? { turnId: event.turnId } : {})
        },
        waiting
      );
    }
  };
  /**
   * @param {string} threadId - Thread identifier.
   * @param {string | undefined} status - Native status.
   * @param {{threadName?: string | null}} [extra] - Optional thread name.
   */
  const transition = async (threadId, status, extra = {}) => {
    const previous = current.get(threadId) ?? null;
    if (previous !== status) {
      current.set(threadId, status);
      if (
        status !== undefined &&
        statuses.includes(status) &&
        observable({ previous, status })
      ) {
        await output({
          ...extra,
          event: "threadStatus",
          previous,
          status,
          threadId
        });
      }
    }
  };
  /**
   * @param {string} threadId - Thread identifier.
   * @param {z.infer<typeof nativeTurn>} turn - Native turn.
   * @param {boolean} initial - Initial observation.
   * @param {boolean} inspection - Whether inspection supplied the turn.
   * @param {boolean} notificationInitial - Whether notification arrived at startup.
   */
  const rememberTerminal = (
    threadId,
    turn,
    initial,
    inspection,
    notificationInitial
  ) => {
    const seen = failures.get(threadId) ?? {};
    const identifiers = [seen.inspection, seen.latest];
    const racedInspection =
      notificationInitial && current.get(threadId) === "active";
    if (
      initial ||
      (inspection && !racedInspection) ||
      !notificationInitial ||
      seen.initialObserved === true ||
      seen.initialHistorical === true
    ) {
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
        seen.initialObserved === true || (!initial && seen.initial === key);
      const initialHistorical = initial
        ? historicalTurn(turn, startedAt)
        : seen.initialHistorical;
      failures.set(threadId, {
        ...seen,
        ...retained,
        initialHistorical,
        initialObserved
      });
    }
    return repeated;
  };
  /**
   * @param {string} threadId - Thread identifier.
   * @param {z.infer<typeof nativeTurn> | undefined} turn - Native turn.
   * @param {{initial?: boolean, inspection?: boolean, notificationInitial?: boolean}} [options] - Observation context.
   */
  const terminal = async (
    threadId,
    turn,
    { initial = false, inspection = false, notificationInitial = false } = {}
  ) => {
    if (
      turn !== undefined &&
      ["failed", "completed", "interrupted"].includes(turn.status ?? "") &&
      (initial || !historicalTurn(turn, startedAt))
    ) {
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
        !initial &&
        !repeated &&
        statuses.includes(status) &&
        observable({ previous, status })
      ) {
        await output(
          {
            ...(turn.error ? { error: turn.error } : {}),
            event: turn.status === "failed" ? "turnError" : "turnCompleted",
            previous,
            status,
            threadId,
            turnId: turn.id ?? null,
            turnStatus: turn.status
          },
          turn
        );
      }
    }
  };
  /**
   * @param {string | null} threadId - Thread identifier, when known.
   * @param {unknown} error - Inspection failure.
   */
  const inspectionError = async (threadId, error) => {
    if (waiting.aborted) {
      throw error;
    }
    if (!signal.aborted) {
      await output({
        error: errorMessage(error),
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
  /** @param {string} threadId - Thread identifier. */
  const latestTurn = async (threadId) => {
    if (!turnReadRefused.has(threadId)) {
      try {
        const page = turnPage.parse(
          await inspector.request("thread/turns/list", {
            itemsView: "notLoaded",
            limit: 1,
            sortDirection: "desc",
            threadId
          })
        );
        return page.data?.[0];
      } catch (error) {
        if (waiting.aborted || signal.aborted || !methodNotSupported(error)) {
          throw error;
        }
        turnReadRefused.add(threadId);
      }
    }
    const { thread } = threadRead.parse(
      await inspector.request("thread/read", { includeTurns: true, threadId })
    );
    return (thread.turns ?? []).at(-1);
  };
  /** @param {string} threadId - Thread identifier. */
  const snapshotStatus = async (threadId) => {
    const { thread } = threadRead.parse(
      await inspector.request("thread/read", { includeTurns: false, threadId })
    );
    const status =
      typeof thread.status === "string"
        ? thread.status
        : (thread.status?.type ?? "notLoaded");
    if (startup.notified.get(threadId) !== status) {
      if (includeInitial) {
        await transition(threadId, status, { threadName: thread.name ?? null });
      } else {
        current.set(threadId, status);
      }
    }
  };
  /**
   * @param {string} threadId - Thread identifier.
   * @param {boolean} [initial] - Initial inspection.
   * @param {boolean} [notificationInitial] - Startup notification.
   */
  const inspect = async (
    threadId,
    initial = false,
    notificationInitial = false
  ) => {
    pending.delete(threadId);
    /** @type {unknown} */
    let turnRejected = null;
    try {
      const latest = await latestTurn(threadId);
      await terminal(threadId, latest, {
        initial,
        inspection: true,
        notificationInitial
      });
    } catch (error) {
      turnRejected = error;
    }
    /** @type {unknown} */
    let statusRejected = null;
    if (initial) {
      try {
        await snapshotStatus(threadId);
      } catch (error) {
        statusRejected = error;
      }
    }
    const rejected = statusRejected ?? turnRejected;
    if (rejected !== null && rejected !== undefined) {
      const withoutTurnRead =
        turnRejected !== null &&
        turnReadRefused.has(threadId) &&
        methodNotSupported(turnRejected) &&
        !waiting.aborted &&
        !signal.aborted;
      if (transientRead(rejected) && !waiting.aborted && !signal.aborted) {
        pending.add(threadId);
        if (pending.size > MAX_PENDING) {
          const oldest = pending.keys().next();
          if (oldest.done !== true) {
            pending.delete(oldest.value);
          }
        }
      } else if (withoutTurnRead) {
        if (rejected !== turnRejected) {
          await inspectionError(threadId, rejected);
        }
        await capabilityNotice();
      } else {
        await inspectionError(threadId, rejected);
      }
    }
  };
  /**
   * @param {z.infer<typeof nativeNotification>} note - Native notification.
   * @param {boolean} notificationInitial - Whether the notification was buffered during startup.
   */
  const handle = async (note, notificationInitial) => {
    const threadId = note.params?.threadId;
    if (
      waiting.aborted ||
      threadId === undefined ||
      threadId === "" ||
      !selected(threadId)
    ) {
      return;
    }
    if (note.method === "thread/status/changed") {
      const status =
        typeof note.params.status === "string"
          ? note.params.status
          : note.params.status?.type;
      if (status === "notLoaded") {
        pending.delete(threadId);
      } else if (status === "idle" || pending.delete(threadId)) {
        await inspect(threadId, false, notificationInitial);
      }
      await transition(threadId, status);
    } else if (note.method === "turn/completed") {
      await terminal(threadId, note.params.turn, { notificationInitial });
    } else if (note.method === "error" && note.params.willRetry !== true) {
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
  const drainNotifications = async () => {
    const next = pendingNotifications.shift();
    if (next) {
      const [note, notificationInitial] = next;
      await handle(note, notificationInitial);
      await drainNotifications();
    }
  };
  try {
    if (!waiting.aborted) {
      let ids = threadIds;
      if (threadIds.includes("*")) {
        ids = [];
        try {
          /** @type {Set<string>} */
          const cursors = new Set();
          /** @param {string} [cursor] - Page cursor. */
          const page = async (cursor) => {
            const loaded = loadedPage.parse(
              await inspector.request(
                "thread/loaded/list",
                cursor !== undefined && cursor !== "" ? { cursor } : {}
              )
            );
            ids.push(...(loaded.data ?? []));
            const next = loaded.nextCursor;
            if (
              next !== null &&
              next !== undefined &&
              next !== "" &&
              cursors.has(next)
            ) {
              throw new Error("Loaded-thread pagination repeated its cursor");
            }
            if (
              next !== null &&
              next !== undefined &&
              next !== "" &&
              !waiting.aborted
            ) {
              cursors.add(next);
              await page(next);
            }
          };
          await page();
        } catch (error) {
          await inspectionError(null, error);
        }
      }
      const remaining = new Set(ids).values();
      const inspectNext = async () => {
        if (!waiting.aborted) {
          const next = remaining.next();
          if (next.done !== true) {
            await inspect(next.value, true);
            await inspectNext();
          }
        }
      };
      await inspectNext();
      await drainNotifications();
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
    initialized.resolve();
    client.close();
    inspector.close();
  }
};
