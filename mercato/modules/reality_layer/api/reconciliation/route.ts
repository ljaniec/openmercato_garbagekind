import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildRealityRequestContext, runRealityMutation, scopedInput } from '../helpers'
const bodySchema = z.object({ diffId: z.string().uuid(), action: z.enum(['merge', 'reject', 'request_more_evidence']), reason: z.string().min(1).max(500).optional() })
export const metadata = { POST: { requireAuth: true, requireFeatures: ['reality_layer.reconciliation.decide'] } }
export async function POST(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const body = bodySchema.parse(await req.json().catch(() => ({})))
    const commandId = body.action === 'merge' ? 'reality_layer.reconciliation.merge' : 'reality_layer.reconciliation.decide'
    const commandBody = body.action === 'merge' ? { diffId: body.diffId } : { diffId: body.diffId, action: body.action, reason: body.reason ?? body.action }
    const result = await runRealityMutation(req, ctx, commandId, scopedInput(ctx, commandBody), 'reality_layer.diff', body.diffId, 'update')
    if (result instanceof Response) return result
    return Response.json({ ok: true, ...(result as Record<string, unknown>) })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 }) }
}
export const openApi: OpenApiRouteDoc = { tag: 'Reality Layer', summary: 'Reconcile RealityDiff', methods: {
  POST: { summary: 'Reconcile RealityDiff', requestBody: { schema: bodySchema }, responses: [{ status: 200, description: 'Reconciliation decision applied', schema: z.object({ ok: z.boolean(), diffId: z.string().uuid() }).passthrough() }], errors: [{ status: 400, description: 'Reconciliation rejected', schema: z.object({ error: z.string() }) }] },
} }
