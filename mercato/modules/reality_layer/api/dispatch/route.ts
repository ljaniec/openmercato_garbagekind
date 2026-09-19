import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildRealityRequestContext, runRealityMutation, scopedInput } from '../helpers'
const bodySchema = z.object({
  intentId: z.string().uuid(), executorId: z.string().min(1).max(191),
  dispatchKey: z.string().uuid(),
  mockScenario: z.enum(['success', 'failure', 'unexpected_result']).default('success'),
})
export const metadata = { POST: { requireAuth: true, requireFeatures: ['reality_layer.execution.dispatch'] } }
export async function POST(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const body = bodySchema.parse(await req.json().catch(() => ({})))
    const result = await runRealityMutation(req, ctx, 'reality_layer.execution.dispatch', scopedInput(ctx, body), 'reality_layer.execution', null, 'create')
    if (result instanceof Response) return result
    return Response.json({ ok: true, ...(result as Record<string, unknown>) }, { status: 202 })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 }) }
}
export const openApi: OpenApiRouteDoc = { tag: 'Reality Layer', summary: 'Dispatch mock physical execution', methods: {
  POST: { summary: 'Dispatch mock physical execution', requestBody: { schema: bodySchema }, responses: [{ status: 202, description: 'Execution queued', schema: z.object({ ok: z.boolean(), executionId: z.string().uuid() }).passthrough() }], errors: [{ status: 400, description: 'Dispatch rejected', schema: z.object({ error: z.string() }) }] },
} }
