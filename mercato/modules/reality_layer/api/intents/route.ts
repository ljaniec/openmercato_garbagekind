import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildRealityRequestContext, runRealityMutation, scopedInput } from '../helpers'

const bodySchema = z.object({
  kind: z.literal('move_object').default('move_object'),
  subjectKind: z.string().min(1).max(80),
  subjectId: z.string().min(1).max(191),
  sourceKind: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(191),
  destinationKind: z.string().min(1).max(80),
  destinationId: z.string().min(1).max(191),
  parameters: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().uuid(),
})

export const metadata = { POST: { requireAuth: true, requireFeatures: ['reality_layer.intent.create'] } }

export async function POST(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const body = bodySchema.parse(await req.json().catch(() => ({})))
    const result = await runRealityMutation(
      req, ctx, 'reality_layer.intent.create', scopedInput(ctx, body),
      'reality_layer.intent', null, 'create',
    )
    if (result instanceof Response) return result
    return Response.json({ ok: true, ...(result as Record<string, unknown>) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Reality Layer', summary: 'Create physical intent', methods: {
    POST: { summary: 'Create physical intent', requestBody: { schema: bodySchema },
      responses: [{ status: 200, description: 'Intent created', schema: z.object({ ok: z.boolean(), intentId: z.string().uuid() }).passthrough() }],
      errors: [{ status: 400, description: 'Invalid request', schema: z.object({ error: z.string() }) }] },
  },
}
