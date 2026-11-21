/**
 * Request bodies for the pricing v2 workshop actions
 * (docs/PRICING_V2_API.md sections 4 and 5). JSON only -- none of these
 * routes take multipart.
 */
import { z } from 'zod';

const money = (label) =>
  z
    .number({ message: `${label} must be a number` })
    .nonnegative({ message: `${label} cannot be negative` })
    .max(9999999, { message: `${label} is too large` })
    // Tolerance, not ===: 0.1 * 100 is 10.000000000000002 in floating point.
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
      message: `${label} can have at most 2 decimals`,
    });

const positiveId = z.number().int().positive();

export const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarter', 'full'];

export const checkInSchema = z
  .object({
    odometer_km: z.number().int().min(0).max(9999999).nullish(),
    fuel_level: z.enum(FUEL_LEVELS).nullish(),
    condition_note: z.string().trim().max(500).nullish(),
  })
  .default({});

const extraWorkItemSchema = z
  .object({
    kind: z.enum(['labour', 'part', 'removal']),
    name: z.string().trim().max(80).optional(),
    // Ignored for a removal (the server copies the quote line), so optional
    // there; checked in superRefine for labour/part.
    qty: z.number().positive().max(9999).optional(),
    unit_price: money('Unit price').optional(),
    quote_line_id: positiveId.nullish(),
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'removal') {
      if (item.quote_line_id == null) {
        ctx.addIssue({ code: 'custom', path: ['quote_line_id'], message: 'A removal needs the quote line it removes' });
      }
      return;
    }
    if (!item.name) ctx.addIssue({ code: 'custom', path: ['name'], message: 'Name is required' });
    if (item.qty == null) ctx.addIssue({ code: 'custom', path: ['qty'], message: 'Quantity is required' });
    else if (Math.abs(Math.round(item.qty * 100) - item.qty * 100) > 1e-6) {
      ctx.addIssue({ code: 'custom', path: ['qty'], message: 'Quantity can have at most 2 decimals' });
    }
    if (item.unit_price == null) ctx.addIssue({ code: 'custom', path: ['unit_price'], message: 'Unit price is required' });
  });

export const extraWorkSchema = z.object({
  reason: z.string().trim().min(3, { message: 'Reason must be at least 3 characters' }).max(300),
  items: z.array(extraWorkItemSchema).min(1, { message: 'Add at least one item' }).max(20),
  supersedes_id: positiveId.nullish(),
});

export const voidBillSchema = z.object({
  reason: z.string().trim().min(3, { message: 'Reason must be at least 3 characters' }).max(300),
});

export const decisionSchema = z
  .object({
    approve: z.array(positiveId).max(100).default([]),
    reject: z.array(positiveId).max(100).default([]),
  })
  .superRefine((body, ctx) => {
    if (body.approve.length + body.reject.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['approve'], message: 'Approve or reject at least one item' });
    }
    if (body.approve.some((id) => body.reject.includes(id))) {
      ctx.addIssue({ code: 'custom', path: ['reject'], message: 'An item cannot be both approved and rejected' });
    }
  });

// G06 "Parts used": a free-text note recorded as a BookingEvent (no table).
export const partsUsedSchema = z.object({
  note: z.string().trim().min(1, { message: 'Note is required' }).max(300),
});
