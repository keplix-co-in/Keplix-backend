import { z } from 'zod';

// z.coerce.number() rather than z.number(): the controllers on both the user
// and vendor side already do `Number(conversationId)` themselves, so the
// wire format has always been "whatever JSON.stringify sends" -- accepting
// only a strict JS number here would reject requests that worked before this
// validator existed, for no real safety gain (audit #113/#120: previously
// there was no validator running here at all).
export const sendMessageSchema = z.object({
  conversationId: z.coerce.number().int().positive().optional(),
  bookingId: z.coerce.number().int().positive().optional(),
  // 4000 is generous for a chat message and cheap insurance against someone
  // pasting a multi-MB string into a booking chat (stored as-is, sent back on
  // every read of the conversation).
  message_text: z.string().min(1, { message: "Message text is required" }).max(4000),
}).refine(data => data.conversationId || data.bookingId, {
    message: "Either conversationId or bookingId must be provided",
    path: ["conversationId"],
});

export const createConversationSchema = z.object({
  bookingId: z.coerce.number().int().positive(),
});
