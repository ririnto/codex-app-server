import { randomUUID } from "node:crypto";

import { z } from "zod";

import { openClient, withClient } from "./connection.mjs";
import { nativeNotification, threadRead } from "./native-schema.mjs";
import { startTurn } from "./turn.mjs";

/**
 * @typedef {object} QueueRecord
 * @property {string} id - Delivery identifier.
 * @property {string} status - Delivery status.
 * @property {string} reason - Delivery reason.
 * @property {string} [text] - Pending message text.
 * @property {string} [turnId] - Started turn identifier.
 * @property {unknown} [error] - Native turn error.
 */

/**
 * @typedef {object} Queue
 * @property {Awaited<ReturnType<typeof openClient>> | null} client - Owned client.
 * @property {boolean} closed - Whether delivery has stopped.
 * @property {boolean} draining - Whether delivery is active.
 * @property {Promise<void> | null} ready - Connection setup.
 * @property {QueueRecord[]} records - Bounded delivery receipts.
 * @property {AbortController} stopped - Queue lifetime.
 * @property {string} threadId - Owned thread identifier.
 * @property {ReturnType<typeof setTimeout>} [timer] - Queue deadline.
 * @property {false | {signal?: AbortSignal}} wake - Deferred delivery.
 */

/** @type {Map<string, Queue>} */
const queues = new Map();
/** @type {Map<string, symbol>} */
const writers = new Map();
const MAX_MESSAGES = 32;
const MAX_THREADS = 128;
const QUEUE_TIMEOUT_MS = 1_800_000;

/**
 * Detect the provider compatibility error without assuming all provider errors are equivalent.
 */
export const unsupportedInterrupt = (value) =>
  /unsupported websocket request type[^]*response\.interrupt/iu.test(
    JSON.stringify(value)
  );

/**
 * Return whether a process-local queue currently owns delivery for this thread.
 * @param {string} threadId - Thread identifier.
 */
export const queuedThread = (threadId) =>
  queues.has(threadId) && !queues.get(threadId).closed;

/**
 * @param {Queue} queue - Queue to stop.
 * @param {string} reason - Refusal reason.
 */
const stop = (queue, reason) => {
  queue.closed = true;
  clearTimeout(queue.timer);
  for (const record of queue.records) {
    if (record.status === "queued") {
      record.reason = reason;
      record.status = "refused";
      delete record.text;
    }
  }
  const { client } = queue;
  queue.client = null;
  queue.stopped.abort(new Error(reason));
  client?.close();
};

/** @param {Queue} queue - Queue to inspect. */
const snapshot = (queue) => ({
  messages: queue.records.map(({ text: _text, ...record }) => record),
  threadId: queue.threadId
});

/**
 * @param {Queue} queue - Queue to prepare.
 * @param {AbortSignal} [signal] - Delivery cancellation.
 */
const prepareDelivery = async (queue, signal) => {
  await queue.ready;
  if (!queue.client) {
    return false;
  }
  const { thread } = threadRead.parse(
    await queue.client.request(
      "thread/read",
      { includeTurns: true, threadId: queue.threadId },
      { signal }
    )
  );
  signal?.throwIfAborted();
  const { turns } = thread;
  for (const entry of queue.records) {
    const turn = turns?.find((item) => item.id === entry.turnId);
    if (entry.status === "started" && turn && turn.status !== "inProgress") {
      entry.status = turn.status;
      if (turn.error) {
        entry.error = turn.error;
      }
    }
  }
  return (
    thread.turns?.at(-1)?.status !== "inProgress" &&
    (typeof thread.status !== "object" || thread.status?.type !== "active")
  );
};

/**
 * @param {Queue | undefined} queue - Queue to inspect.
 * @param {AbortSignal} [signal] - Delivery cancellation.
 */
const pendingWake = (queue, signal) =>
  queue !== undefined &&
  queue.wake !== false &&
  !queue.closed &&
  queue.wake.signal?.aborted !== true
    ? { signal: signal?.aborted === true ? queue.wake.signal : signal }
    : null;

/**
 * @param {Queue} queue - Queue to drain.
 * @param {AbortSignal} [signal] - Delivery cancellation.
 */
const deliver = async (queue, signal) => {
  if (signal?.aborted === true) {
    return;
  }
  if (queue.draining || writers.has(queue.threadId)) {
    if (queue.wake === false || signal === undefined) {
      queue.wake = { signal };
    }
    return;
  }
  queue.draining = true;
  const owner = Symbol(queue.threadId);
  writers.set(queue.threadId, owner);
  const { wake } = queue;
  queue.wake = false;
  try {
    if (!(await prepareDelivery(queue, signal))) {
      return;
    }
    const record = queue.records.find((entry) => entry.status === "queued");
    if (!record) {
      stop(queue, "Queue drained");
      return;
    }
    record.status = "delivering";
    try {
      const result = await startTurn(queue.client, queue.threadId, record.text);
      record.status = "started";
      record.turnId = result.turnId;
      delete record.text;
    } catch (error) {
      record.reason = `${error.message}; delivery may be unconfirmed and will not be retried`;
      record.status = "refused";
      delete record.text;
      stop(queue, "Delivery stopped after an error; no retry was attempted");
    }
  } catch (error) {
    if (signal?.aborted === true) {
      if (wake !== false && wake.signal === undefined && !queue.wake) {
        queue.wake = wake;
      }
    } else {
      stop(
        queue,
        error instanceof Error ? error.message : "Queue delivery failed"
      );
    }
  } finally {
    queue.draining = false;
    if (writers.get(queue.threadId) === owner) {
      writers.delete(queue.threadId);
    }
    const pending = pendingWake(queue, signal);
    if (pending) {
      await deliver(queue, pending.signal);
    }
  }
};

/**
 * Queue authorized text in memory and deliver it as a fresh turn after observed completion.
 * Native writer refusals stop delivery without forcing locks or retrying ambiguous writes.
 * @param {string} threadId - Thread identifier.
 * @param {string} text - Authorized message.
 * @param {string} [reason] - Reason for queuing.
 * @param {{signal?: AbortSignal, acknowledge?: () => void}} [operation] - Caller cancellation and acknowledgement.
 */
export const enqueueMessage = async (
  threadId,
  text,
  reason = "Active turn",
  operation = {}
) => {
  let queue = queues.get(threadId);
  if (!queue || queue.closed) {
    if (!queue && queues.size >= MAX_THREADS) {
      const retired = [...queues].find(([, entry]) => entry.closed);
      if (!retired) {
        throw new Error("Thread queue capacity reached");
      }
      queues.delete(retired[0]);
    }
    queue = {
      client: null,
      closed: false,
      draining: false,
      ready: null,
      records: [],
      stopped: new AbortController(),
      threadId,
      wake: false
    };
    queues.set(threadId, queue);
    queue.timer = setTimeout(() => {
      stop(queue, "Queue deadline expired");
    }, QUEUE_TIMEOUT_MS);
    queue.ready = (async () => {
      const client = await openClient({ signal: queue.stopped.signal });
      if (queue.closed) {
        client.close();
        return;
      }
      queue.client = client;
      queue.client.signal.addEventListener(
        "abort",
        () => {
          stop(queue, "Queue connection closed; delivery is not retried");
        },
        { once: true, signal: queue.stopped.signal }
      );
      queue.client.events.addEventListener(
        "notification",
        (event) => {
          const parsed = nativeNotification.safeParse(
            event instanceof CustomEvent ? event.detail : undefined
          );
          if (
            parsed.success &&
            parsed.data.params?.threadId === threadId &&
            (parsed.data.method === "turn/completed" ||
              parsed.data.method === "thread/status/changed")
          ) {
            void deliver(queue);
          }
        },
        { signal: queue.stopped.signal }
      );
      await queue.client.request("thread/resume", {
        excludeTurns: true,
        threadId
      });
    })();
  }
  if (
    queue.records.filter(
      (entry) => entry.status === "queued" || entry.status === "delivering"
    ).length >= MAX_MESSAGES
  ) {
    throw new Error("Thread message queue is full");
  }
  if (queue.records.length >= MAX_MESSAGES) {
    const retired = queue.records.findIndex(
      (entry) => entry.status !== "queued" && entry.status !== "delivering"
    );
    if (retired !== -1) {
      queue.records.splice(retired, 1);
    }
  }
  const record = { id: randomUUID(), reason, status: "queued", text };
  queue.records.push(record);
  /** @type {PromiseWithResolvers<void>} */
  const cancelled = Promise.withResolvers();
  if (operation.signal) {
    const cancel = () => {
      if (queue.wake !== false && queue.wake.signal === operation.signal) {
        queue.wake = false;
      }
      if (record.status === "queued") {
        queue.records.splice(queue.records.indexOf(record), 1);
        delete record.text;
        if (queue.records.length === 0) {
          stop(queue, "Enqueue operation cancelled before acknowledgement");
        }
      }
      cancelled.resolve();
    };
    operation.acknowledge = () => {
      operation.signal.removeEventListener("abort", cancel);
    };
    operation.signal.addEventListener("abort", cancel, { once: true });
    if (operation.signal.aborted) {
      cancel();
    }
  }
  try {
    await Promise.race([queue.ready, cancelled.promise]);
    operation.signal?.throwIfAborted();
    await deliver(queue, operation.signal);
  } catch (error) {
    if (operation.signal?.aborted !== true) {
      stop(
        queue,
        error instanceof Error ? error.message : "Queue delivery failed"
      );
    }
  }
  return {
    ...snapshot(queue).messages.find((entry) => entry.id === record.id),
    threadId
  };
};

/**
 * Serialize curated writes per thread and return structured refusal outcomes.
 * @template {{thread_id: string}} T
 * @param {(client: Awaited<ReturnType<typeof openClient>>, args: T, release: () => void, operation: {signal?: AbortSignal, acknowledge?: () => void}) => unknown} handler - Authorized write handler.
 * @returns {(args: T, extra?: {signal?: AbortSignal}) => Promise<{content: {text: string | undefined, type: string}[], isError?: boolean}>} Serialized write handler.
 */
export const withThreadWriter = (handler) => async (args, extra) => {
  const threadId = args.thread_id;
  if (writers.has(threadId)) {
    return {
      content: [
        {
          text: JSON.stringify({
            reason: "Another plugin operation owns this thread",
            status: "refused",
            threadId
          }),
          type: "text"
        }
      ],
      isError: true
    };
  }
  const owner = Symbol(threadId);
  /** @type {{signal?: AbortSignal, acknowledge?: () => void}} */
  const operation = { signal: extra?.signal };
  writers.set(threadId, owner);
  const release = () => {
    if (writers.get(threadId) === owner) {
      writers.delete(threadId);
    }
  };
  let response;
  try {
    const result = await withClient(
      /** @param {Awaited<ReturnType<typeof openClient>>} client - Native client.
       * @param {T} input - Tool arguments.
       */
      (client, input) => handler(client, input, release, operation)
    )(args, extra);
    response =
      result.isError === true
        ? {
            ...result,
            content: [
              {
                text: JSON.stringify({
                  reason: result.content[0].text,
                  status: "refused",
                  threadId
                }),
                type: "text"
              }
            ]
          }
        : result;
  } finally {
    try {
      release();
      const queue = queues.get(threadId);
      const pending = pendingWake(queue, operation.signal);
      if (pending) {
        await deliver(queue, pending.signal);
      }
    } finally {
      operation.acknowledge?.();
    }
  }
  return response;
};

/**
 * Register read-only queue receipts and cancellation of undelivered messages.
 * @param {import("./types.d.ts").ToolRegistry} server - Curated tool registry.
 */
export const registerQueueTools = (server) => {
  server.registerTool(
    "codex_queue",
    {
      description:
        "Inspect process-local queued-message receipts or cancel undelivered messages. Queues expire after 30 minutes and are lost when this MCP process stops. No delivery is retried after a socket or writer error.",
      inputSchema: {
        action: z
          .enum(["status", "cancel"])
          .optional()
          .describe(
            "status reads receipts; cancel refuses undelivered messages and closes the queue connection."
          ),
        thread_id: z
          .string()
          .describe(
            "Authorized thread ID whose message queue should be inspected or cancelled."
          )
      }
    },
    ({ action = "status", thread_id: threadId }) => {
      const queue = queues.get(threadId);
      if (action === "cancel" && queue) {
        stop(
          queue,
          "Cancelled by caller; an already-started delivery is not interrupted"
        );
      }
      return {
        content: [
          {
            text: JSON.stringify(
              queue ? snapshot(queue) : { messages: [], threadId }
            ),
            type: "text"
          }
        ]
      };
    }
  );
};

/**
 * Release task-owned queue connections when the MCP transport closes.
 */
export const closeQueues = () => {
  for (const queue of queues.values()) {
    stop(queue, "MCP server closed");
  }
};
