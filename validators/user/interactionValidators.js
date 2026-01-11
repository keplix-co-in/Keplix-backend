import { z } from 'zod';

export const sendMessageSchema = z.object({
  conversationId: z.number().int().optional(),
  bookingId: z.number().int().optional(),
  message_text: z.string().min(1, { message: "Message text is required" }),
}).refine(data => data.conversationId || data.bookingId, {
    message: "Either conversationId or bookingId must be provided",
    path: ["conversationId"],
});
