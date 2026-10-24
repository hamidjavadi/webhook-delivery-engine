import { z } from 'zod';
import type { JsonValue } from '../../core/types.js';

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).readonly(),
    z.record(z.string(), jsonValueSchema).readonly(),
  ]),
);

/**
 * Validates the strict public request body for webhook ingestion.
 *
 * Client identity and timestamps are deliberately absent because the
 * configured engine context supplies them. The optional destination URL
 * is resolved to configuration by the ingestion handler before SSRF checks.
 */
export const ingestionRequestSchema = z
  .object({
    idempotency_key: z.string().refine((value) => value.trim().length > 0),
    payload: jsonValueSchema,
    destination_url: z.string().optional(),
  })
  .strict()
  .readonly();

/**
 * The validated shape of the parsed JSON ingestion request body.
 */
export type IngestionRequest = z.infer<typeof ingestionRequestSchema>;
