import { z } from 'zod'

const MAX_JSON_BYTES = 16 * 1024

function boundedJsonRecord(label: string) {
  return z
    .record(z.string().min(1).max(120), z.unknown())
    .superRefine((value, ctx) => {
      let encoded = ''
      try {
        encoded = JSON.stringify(value)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: label + ' must be JSON-serializable.',
        })
        return
      }
      if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: label + ' exceeds the 16 KiB limit.',
        })
      }
    })
}

export const realityScopeSchema = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const semanticRefKind = z.string().trim().min(1).max(80)
const semanticRefId = z.string().trim().min(1).max(191)

export const physicalIntentCreateSchema = realityScopeSchema
  .extend({
    kind: z.literal('move_object').default('move_object'),
    subjectKind: semanticRefKind,
    subjectId: semanticRefId,
    sourceKind: semanticRefKind.optional(),
    sourceId: semanticRefId.optional(),
    destinationKind: semanticRefKind,
    destinationId: semanticRefId,
    contextKind: semanticRefKind.optional(),
    contextId: semanticRefId.optional(),
    parameters: boundedJsonRecord('parameters').default({}),
    originContext: boundedJsonRecord('originContext').optional(),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((value, ctx) => {
    if ((value.sourceKind == null) !== (value.sourceId == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceKind and sourceId must be provided together.',
        path: ['sourceKind'],
      })
    }
    if ((value.contextKind == null) !== (value.contextId == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contextKind and contextId must be provided together.',
        path: ['contextKind'],
      })
    }
  })

export const authorizationGrantSchema = realityScopeSchema.extend({
  intentId: z.string().uuid(),
  executorId: z.string().trim().min(1).max(191),
  expiresAt: z.coerce.date(),
  idempotencyKey: z.string().uuid(),
})

export const intentCancelSchema = realityScopeSchema.extend({
  intentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export type PhysicalIntentCreateInput = z.infer<typeof physicalIntentCreateSchema>
export type AuthorizationGrantInput = z.infer<typeof authorizationGrantSchema>
export type IntentCancelInput = z.infer<typeof intentCancelSchema>
