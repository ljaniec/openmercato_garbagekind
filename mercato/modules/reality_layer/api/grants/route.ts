import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildRealityRequestContext, runRealityMutation, scopedInput } from '../helpers'

const bodySchema = z.object({
  intentId: z.string().uuid(),
  executorId: z.string().min(1).max(191),
  expiresAt: z.coerce.date(),
  idempotencyKey: z.string().uuid(),
})
export const metadata = { POST: { requireAuth: true, requireFeatures: ['reality_layer.authorization.grant'] } }
export async function POST(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const body = bodySchema.parse(await req.json().catch(() => ({})))
    const result = await runRealityMutation(req, ctx, 'reality_layer.authorization.grant', scopedInput(ctx, body), 'reality_layer.authorization_grant', null, 'create')
    if (result instanceof Response) return result
    return Response.json({ ok: true, ...(result as Record<string, unknown>) })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 }) }
}
export const openApi: OpenApiRouteDoc = { tag: 'Reality Layer', summary: 'Grant physical authorization', methods: {
  POST: { summary: 'Grant physical authorization', requestBody: { schema: bodySchema }, responses: [{ status: 200, description: 'Grant created', schema: z.object({ ok: z.boolean(), grantId: z.string().uuid() }).passthrough() }], errors: [{ status: 400, description: 'Invalid request', schema: z.object({ error: z.string() }) }] },
} }
