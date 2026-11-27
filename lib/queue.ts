import { randomUUID } from "node:crypto";

import { z } from "zod";

import { openClient, withClient } from "#lib/connection";
import { nativeNotification, threadRead } from "#lib/native-schema";
import { startTurn } from "#lib/turn";

interface QueueRecord {
  id: string;
  status: string;
  reason: string;
  text?: string;
  turnId?: string;
  error?: unknown;
}

interface Queue {
  client: Awaited<ReturnType<typeof openClient>> | null;
  closed: boolean;
  draining: boolean;
  delivery: Promise<void> | null;
  ready: Promise<void> | null;
  records: QueueRecord[];
  stopped: AbortController;
  threadId: string;
  timer?: ReturnType<typeof setTimeout>;
  wake: false | { signal?: AbortSignal };
}

const queues = new Map<string, Queue>();
const writers = new Map<string, symbol>();
const MAX_MESSAGES = 32;
const MAX_THREADS = 128;
const QUEUE_TIMEOUT_MS = 1_800_000;

/**
 * Detect the provider compatibility error without assuming all provider errors are equivalent.
 */
export const unsupportedInterrupt = (value: unknown) =>
  /unsupported websocket request type[^]*response\.interrupt/iu.test(
    JSON.stringify(value)
  );

/**
 * Return whether a process-local queue currently owns delivery for this thread.
 */
export const queuedThread = (threadId: string) =>
  queues.get(threadId)?.closed === false;

const stop = (queue: Queue, reason: string) => {
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

const snapshot = (queue: Queue) => ({
  messages: queue.records.map(({ text: _text, ...record }) => record),
  threadId: queue.threadId
});

/**
 * Require observed idle evidence before starting another turn.
 */
export const isThreadIdle = (thread: z.infer<typeof threadRead>["thread"]) => {
  const { turns } = thread;
  const status =
    typeof thread.status === "string" ? thread.status : thread.status?.type;
  const lastTurn = turns?.at(-1);
  if (
    (status !== undefined && status !== "idle") ||
    lastTurn?.status === "inProgress"
  ) {
    return false;
  }
  return (
    status === "idle" ||
    (Array.isArray(turns) &&
      (turns.length === 0 ||
        ["completed", "failed", "interrupted"].includes(
          lastTurn?.status ?? ""
        )))
  );
};

const prepareDelivery = async (queue: Queue, signal?: AbortSignal) => {
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
    if (
      entry.status === "started" &&
      turn &&
      typeof turn.status === "string" &&
      turn.status !== "inProgress"
    ) {
      entry.status = turn.status;
      if (turn.error) {
        entry.error = turn.error;
      }
    }
  }
  return isThreadIdle(thread);
};

const pendingWake = (queue: Queue | undefined, signal?: AbortSignal) =>
  queue !== undefined &&
  queue.wake !== false &&
  !queue.closed &&
  queue.wake.signal?.aborted !== true
    ? { signal: signal?.aborted === true ? queue.wake.signal : signal }
    : null;

const aborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

const deliver = async (queue: Queue, signal?: AbortSignal) => {
  if (aborted(signal)) {
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
    const { client } = queue;
    if (!client || record.text === undefined) {
      stop(queue, "Queue delivery could not be prepared");
      return;
    }
    record.status = "delivering";
    try {
      const result = await startTurn(client, queue.threadId, record.text);
      record.status = "started";
      record.turnId = result.turnId;
      delete record.text;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Queue delivery failed";
      record.reason = `${message}; delivery may be unconfirmed and will not be retried`;
      record.status = "refused";
      delete record.text;
      stop(queue, "Delivery stopped after an error; no retry was attempted");
    }
  } catch (error) {
    if (aborted(signal)) {
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
 */
export const enqueueMessage = async (
  threadId: string,
  text: string,
  reason = "Active turn",
  operation: { signal?: AbortSignal; acknowledge?: () => void } = {}
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
    const createdQueue: Queue = {
      client: null,
      closed: false,
      draining: false,
      delivery: null,
      ready: null,
      records: [],
      stopped: new AbortController(),
      threadId,
      wake: false
    };
    queue = createdQueue;
    queues.set(threadId, createdQueue);
    createdQueue.timer = setTimeout(() => {
      stop(createdQueue, "Queue deadline expired");
    }, QUEUE_TIMEOUT_MS);
    createdQueue.ready = (async () => {
      const client = await openClient({ signal: createdQueue.stopped.signal });
      if (createdQueue.closed) {
        client.close();
        return;
      }
      createdQueue.client = client;
      createdQueue.client.signal.addEventListener(
        "abort",
        () => {
          stop(
            createdQueue,
            "Queue connection closed; delivery is not retried"
          );
        },
        { once: true, signal: createdQueue.stopped.signal }
      );
      createdQueue.client.events.addEventListener(
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
            createdQueue.delivery = (async () => {
              try {
                await deliver(createdQueue);
              } catch (error) {
                stop(
                  createdQueue,
                  error instanceof Error
                    ? error.message
                    : "Queue delivery failed"
                );
              }
            })();
          }
        },
        { signal: createdQueue.stopped.signal }
      );
      await createdQueue.client.request("thread/resume", {
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
  const record: QueueRecord = {
    id: randomUUID(),
    reason,
    status: "queued",
    text
  };
  queue.records.push(record);
  const cancelled: PromiseWithResolvers<void> = Promise.withResolvers();
  if (operation.signal) {
    const { signal } = operation;
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
      signal.removeEventListener("abort", cancel);
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
 */
export const withThreadWriter =
  <T extends { thread_id: string }>(
    handler: (
      client: Awaited<ReturnType<typeof openClient>>,
      args: T,
      release: () => void,
      operation: { signal?: AbortSignal; acknowledge?: () => void }
    ) => unknown
  ): ((
    args: T,
    extra?: { signal?: AbortSignal }
  ) => Promise<{
    content: { text: string | undefined; type: string }[];
    isError?: boolean;
  }>) =>
  async (args, extra) => {
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
    const operation: { signal?: AbortSignal; acknowledge?: () => void } = {
      signal: extra?.signal
    };
    writers.set(threadId, owner);
    const release = () => {
      if (writers.get(threadId) === owner) {
        writers.delete(threadId);
      }
    };
    let response;
    try {
      const result = await withClient(
        (client: Awaited<ReturnType<typeof openClient>>, input: T) =>
          handler(client, input, release, operation)
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
        if (pending && queue) {
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
export const registerQueueTools = (
  server: import("./types.d.ts").ToolRegistry
) => {
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
