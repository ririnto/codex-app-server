import { once } from "node:events";

import { z } from "zod";

import { openClient } from "#lib/connection";
import {
  nativeItem,
  nativeNotification,
  nativeTurn,
  threadRead
} from "#lib/native-schema";

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
type MonitorEvent = Record<string, unknown> & {
  event: string;
  threadId: string | null;
  threadName?: string | null;
  turnId?: string | null;
  enrichmentError?: string;
  error?: unknown;
};

const errorMessage = (error: unknown) => {
  const result = nativeError.safeParse(error);
  return result.success ? result.data.message : "";
};

/**
 * Detect a method-not-supported rejection for the requested read.
 */
const methodNotSupported = (error: unknown) =>
  /"code":-32601/u.test(errorMessage(error));

/**
 * Detect a transient rejection for a thread whose rollout file has no content yet.
 */
const emptyRollout = (error: unknown) =>
  /"code":-32603/u.test(errorMessage(error)) &&
  /"message":"[^]*rollout[^]*is empty/iu.test(errorMessage(error));

/**
 * Detect a transient rejection for a thread whose history is not materialized yet.
 */
const notMaterialized = (error: unknown) =>
  /"code":-32600/u.test(errorMessage(error)) &&
  /"message":"[^]*not materialized/iu.test(errorMessage(error));

/**
 * Detect a transient turn-read rejection that a later inspection may resolve.
 */
const transientRead = (error: unknown) =>
  emptyRollout(error) || notMaterialized(error);

/**
 * Determine whether native completion timing establishes a pre-launch turn.
 */
const historicalTurn = (turn: z.infer<typeof nativeTurn>, startedAt: number) =>
  typeof turn.completedAt === "number" && turn.completedAt < startedAt;

/**
 * Watch native thread status broadcasts without resuming threads or claiming a writer.
 * Silently baseline existing work and output configured, enriched events one at a time.
 */
export const watchThreads = async ({
  emit,
  includeInitial = false,
  includePreviousNotLoaded = false,
  includeUnnamed = false,
  signal,
  statuses,
  threadIds
}: {
  emit: (event: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
  includeInitial?: boolean;
  includePreviousNotLoaded?: boolean;
  includeUnnamed?: boolean;
  signal: AbortSignal;
  statuses: string[];
  threadIds: string[];
}) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const notified = new Map<string, string | null | undefined>();
  const startup = { notified, ready: false };
  const pendingNotifications: [z.infer<typeof nativeNotification>, boolean][] =
    [];
  const initialized: PromiseWithResolvers<
    | ((
        note: z.infer<typeof nativeNotification>,
        initial: boolean
      ) => Promise<void>)
    | undefined
  > = Promise.withResolvers();
  let clientReady = false;
  const observeNotification = (message: object): boolean | undefined => {
    const parsed = nativeNotification.safeParse(message);
    let initial: boolean | undefined;
    if (parsed.success) {
      const { data: note } = parsed;
      const { params } = note;
      const threadId = params?.threadId;
      if (
        params !== undefined &&
        ["thread/status/changed", "turn/completed", "error"].includes(
          note.method
        ) &&
        threadId !== undefined &&
        threadId !== "" &&
        (threadIds.includes("*") || threadIds.includes(threadId)) &&
        !(note.method === "error" && params.willRetry === true)
      ) {
        initial = !startup.ready;
        if (initial && (startup.notified.get(threadId) ?? "") === "") {
          let status = null;
          if (note.method === "thread/status/changed") {
            status =
              typeof params.status === "string"
                ? params.status
                : params.status?.type;
          }
          startup.notified.set(threadId, status);
        }
      }
    }
    return initial;
  };
  const notification = async (
    message: object,
    notificationInitial: unknown
  ) => {
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
    initialized.resolve(undefined);
    client.close();
    throw error;
  }
  const waiting = AbortSignal.any([signal, client.signal, inspector.signal]);
  const ended = once(waiting, "abort");
  const observable = ({
    previous,
    status
  }: {
    previous: string | null;
    status: string | undefined;
  }) =>
    (previous !== null || includeInitial) &&
    (previous !== "notLoaded" ||
      includePreviousNotLoaded ||
      status === "failed" ||
      status === "systemError");
  const current = new Map<string, string | undefined>();
  const failures = new Map<
    string,
    {
      initial?: string;
      latest?: string;
      inspection?: string;
      initialObserved?: boolean;
      initialHistorical?: boolean;
    }
  >();
  const pending = new Set<string>();
  const turnReadRefused = new Set<string>();
  const capability = { noticed: false };
  const selected = (threadId: string) =>
    threadIds.includes("*") || threadIds.includes(threadId);
  const turnItems = async (threadId: string, turnId: string) => {
    let items: z.infer<typeof nativeItem>[] = [];
    const cursors = new Set<string>();
    const page = async (cursor?: string) => {
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
  const finalMessage = async (
    threadId: string,
    turn: z.infer<typeof nativeTurn>
  ) => {
    let result;
    try {
      if (typeof turn.id !== "string") {
        throw new TypeError("Terminal notification has no turn ID");
      }
      const items =
        Array.isArray(turn.items) &&
        !["notLoaded", "summary"].includes(turn.itemsView ?? "")
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
  const output = async (
    event: MonitorEvent,
    turn?: z.infer<typeof nativeTurn>
  ) => {
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
      const details: {
        enrichmentError?: string;
        finalMessage?: string | null;
      } =
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
  const transition = async (
    threadId: string,
    status: string | undefined,
    extra: { threadName?: string | null } = {}
  ) => {
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
  const rememberTerminal = (
    threadId: string,
    turn: z.infer<typeof nativeTurn>,
    initial: boolean,
    inspection: boolean,
    notificationInitial: boolean
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
  const terminal = async (
    threadId: string,
    turn: z.infer<typeof nativeTurn> | undefined,
    {
      initial = false,
      inspection = false,
      notificationInitial = false
    }: {
      initial?: boolean;
      inspection?: boolean;
      notificationInitial?: boolean;
    } = {}
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
  const inspectionError = async (threadId: string | null, error: unknown) => {
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
  const latestTurn = async (threadId: string) => {
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
  const snapshotStatus = async (threadId: string) => {
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
  const inspect = async (
    threadId: string,
    initial = false,
    notificationInitial = false
  ) => {
    pending.delete(threadId);
    let turnRejected: unknown = null;
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
    let statusRejected: unknown = null;
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
  const handle = async (
    note: z.infer<typeof nativeNotification>,
    notificationInitial: boolean
  ) => {
    const { params } = note;
    const threadId = params?.threadId;
    if (
      waiting.aborted ||
      params === undefined ||
      threadId === undefined ||
      threadId === "" ||
      !selected(threadId)
    ) {
      return;
    }
    if (note.method === "thread/status/changed") {
      const status =
        typeof params.status === "string" ? params.status : params.status?.type;
      if (status === "notLoaded") {
        pending.delete(threadId);
      } else if (status === "idle" || pending.delete(threadId)) {
        await inspect(threadId, false, notificationInitial);
      }
      await transition(threadId, status);
    } else if (note.method === "turn/completed") {
      await terminal(threadId, params.turn, { notificationInitial });
    } else if (note.method === "error" && params.willRetry !== true) {
      await terminal(
        threadId,
        {
          error: params.error,
          id: params.turnId,
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
          const cursors = new Set<string>();
          const page = async (cursor?: string) => {
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
    initialized.resolve(undefined);
    client.close();
    inspector.close();
  }
};
