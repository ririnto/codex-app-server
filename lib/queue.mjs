import { randomUUID } from "node:crypto";

import { z } from "zod";

import { openClient, withClient } from "./connection.mjs";
import { startTurn } from "./turn.mjs";

const queues = new Map();
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
 */
export const queuedThread = (threadId) =>
  queues.has(threadId) && !queues.get(threadId).closed;

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

const snapshot = (queue) => ({
  messages: queue.records.map(({ text: _text, ...record }) => record),
  threadId: queue.threadId
});

const prepareDelivery = async (queue, signal) => {
  await queue.ready;
  if (!queue.client) {
    return false;
  }
  const { thread } = await queue.client.request(
    "thread/read",
    { includeTurns: true, threadId: queue.threadId },
    { signal }
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
    thread.status?.type !== "active"
  );
};

const pendingWake = (queue, signal) =>
  queue?.wake && !queue.closed && !queue.wake.signal?.aborted
    ? { signal: signal?.aborted ? queue.wake.signal : signal }
    : null;

const deliver = async (queue, signal) => {
  if (signal?.aborted) {
    return;
  }
  if (queue.draining || writers.has(queue.threadId)) {
    if (!queue.wake || !signal) {
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
    if (signal?.aborted) {
      if (wake && !wake.signal && !queue.wake) {
        queue.wake = wake;
      }
    } else {
      stop(queue, error.message);
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
    queue.timer = setTimeout(
      () => stop(queue, "Queue deadline expired"),
      QUEUE_TIMEOUT_MS
    );
    queue.ready = (async () => {
      const client = await openClient({ signal: queue.stopped.signal });
      if (queue.closed) {
        client.close();
        return;
      }
      queue.client = client;
      queue.client.signal.addEventListener(
        "abort",
        () => stop(queue, "Queue connection closed; delivery is not retried"),
        { once: true, signal: queue.stopped.signal }
      );
      queue.client.events.addEventListener(
        "notification",
        async ({ detail: note }) => {
          if (
            note.params?.threadId === threadId &&
            (note.method === "turn/completed" ||
              note.method === "thread/status/changed")
          ) {
            await deliver(queue);
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
  const cancelled = Promise.withResolvers();
  if (operation.signal) {
    const cancel = () => {
      if (queue.wake?.signal === operation.signal) {
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
    operation.acknowledge = () =>
      operation.signal.removeEventListener("abort", cancel);
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
    if (!operation.signal?.aborted) {
      stop(queue, error.message);
    }
  }
  return {
    ...snapshot(queue).messages.find((entry) => entry.id === record.id),
    threadId
  };
};

/**
 * Serialize curated writes per thread and return structured refusal outcomes.
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
  const operation = { signal: extra?.signal };
  writers.set(threadId, owner);
  const release = () => {
    if (writers.get(threadId) === owner) {
      writers.delete(threadId);
    }
  };
  let response;
  try {
    const result = await withClient((client, input) =>
      handler(client, input, release, operation)
    )(args, extra);
    response = result.isError
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
