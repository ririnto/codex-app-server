import { on } from "node:events";

import { z } from "zod";

import { nativeNotification } from "#lib/native-schema";

const startedTurn = z.looseObject({
  turn: z.looseObject({ id: z.string() })
});

/**
 * Wait for the turn's completion and collect its final agent message until the deadline.
 */
const awaitTurn = async (
  client: Awaited<ReturnType<typeof import("./connection.ts").openClient>>,
  notifications: AsyncIterable<unknown[]>,
  turnId: string,
  waitSeconds: number,
  waiting: AbortController
) => {
  const result: {
    finalMessage: string | null;
    status: string;
    turnId: string;
  } = { finalMessage: null, status: "waitTimedOut", turnId };
  const timer = setTimeout(() => {
    waiting.abort();
  }, waitSeconds * 1000);
  try {
    for await (const [event] of notifications) {
      if (!(event instanceof CustomEvent)) {
        continue;
      }
      const parsed = nativeNotification.safeParse(event.detail);
      if (!parsed.success) {
        continue;
      }
      const note = parsed.data;
      const params = note.params ?? {};
      if (
        note.method === "item/completed" &&
        params.turnId === turnId &&
        params.item?.type === "agentMessage" &&
        params.item.phase === "final_answer"
      ) {
        result.finalMessage = params.item.text ?? null;
      }
      if (note.method === "turn/completed" && params.turn?.id === turnId) {
        return {
          ...result,
          ...(params.turn.error ? { error: params.turn.error } : {}),
          finalMessage:
            params.turn.status === "completed" ? result.finalMessage : null,
          status: params.turn.status
        };
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
  return client.signal.aborted
    ? { ...result, status: "connectionClosed" }
    : result;
};

/**
 * Start one turn with completion notifications buffered before the request is sent.
 * Release the caller's optional writer after acknowledgment, before waiting for completion.
 */
export const startTurn = async (
  client: Awaited<ReturnType<typeof import("./connection.ts").openClient>>,
  threadId: string,
  text: string,
  waitSeconds = 0,
  onStarted: (() => void) | null = null
) => {
  const waiting = new AbortController();
  const notifications =
    waitSeconds > 0
      ? on(client.events, "notification", {
          signal: AbortSignal.any([waiting.signal, client.signal])
        })
      : null;
  try {
    const started = startedTurn.parse(
      await client.request("turn/start", {
        input: [{ text, type: "text" }],
        threadId
      })
    );
    const turnId = started.turn.id;
    onStarted?.();
    return notifications
      ? await awaitTurn(client, notifications, turnId, waitSeconds, waiting)
      : { finalMessage: null, status: "started", turnId };
  } finally {
    await notifications?.return?.();
  }
};
