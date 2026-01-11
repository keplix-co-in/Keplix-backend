import { z } from 'zod';

export const uploadDocumentSchema = z.object({
  document_type: z.string().min(1, { message: "Document type is required" }),
});
