import { JSONRPCNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Native thread status, preserving additional fields.
 */
export const nativeStatus = z.union([
  z.string(),
  z.looseObject({ type: z.string() })
]);

/**
 * Native turn item fields consumed by thread inspection.
 */
export const nativeItem = z.looseObject({
  phase: z.string().nullish(),
  text: z.string().nullish(),
  type: z.string()
});

/**
 * Native turn fields consumed by inspection and delivery.
 */
export const nativeTurn = z.looseObject({
  completedAt: z.number().nullish(),
  error: z.looseObject({}).nullish(),
  id: z.string().optional(),
  items: z.array(nativeItem).nullish(),
  itemsView: z.string().nullish(),
  status: z.string().optional()
});

/**
 * Native thread fields consumed by thread inspection and delivery.
 */
export const nativeThread = z.looseObject({
  name: z.string().nullish(),
  status: nativeStatus.nullish(),
  turns: z.array(nativeTurn).nullish()
});

/**
 * Native thread read response.
 */
export const threadRead = z.looseObject({ thread: nativeThread });

/**
 * Native notification fields consumed by monitor and turn handling.
 */
export const nativeNotification = JSONRPCNotificationSchema.omit({
  jsonrpc: true
})
  .extend({
    params: z
      .looseObject({
        error: z.looseObject({}).nullish(),
        item: nativeItem.optional(),
        status: nativeStatus.optional(),
        threadId: z.string().optional(),
        turn: nativeTurn.optional(),
        turnId: z.string().optional(),
        willRetry: z.boolean().optional()
      })
      .optional()
  })
  .loose();
