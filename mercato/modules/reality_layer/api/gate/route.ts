import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildRealityRequestContext, runRealityMutation, scopedInput } from '../helpers'
const bodySchema = z.object({ intentId: z.string().uuid(), executorId: z.string().min(1).max(191) })
export const metadata = { POST: { requireAuth: true, requireFeatures: ['reality_layer.execution.dispatch'] } }
export async function POST(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const body = bodySchema.parse(await req.json().catch(() => ({})))
    const result = await runRealityMutation(req, ctx, 'reality_layer.gate.evaluate', scopedInput(ctx, body), 'reality_layer.intent', body.intentId, 'update')
    if (result instanceof Response) return result
    return Response.json({ ok: true, ...(result as Record<string, unknown>) })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 }) }
}
export const openApi: OpenApiRouteDoc = { tag: 'Reality Layer', summary: 'Evaluate Reality Gate', methods: {
  POST: { summary: 'Evaluate Reality Gate', requestBody: { schema: bodySchema }, responses: [{ status: 200, description: 'Gate evaluated', schema: z.object({ ok: z.boolean(), decision: z.string() }).passthrough() }], errors: [{ status: 400, description: 'Gate failed', schema: z.object({ error: z.string() }) }] },
} }
