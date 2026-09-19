import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ExecutionRecord, EvidenceEnvelope, PhysicalIntent, RealityDiff } from '../../data/entities'
import { buildRealityRequestContext } from '../helpers'

const querySchema = z.object({ intentId: z.string().uuid() })
export const metadata = { GET: { requireAuth: true, requireFeatures: ['reality_layer.intent.view'] } }
export async function GET(req: Request) {
  try {
    const ctx = await buildRealityRequestContext(req)
    const q = querySchema.parse({ intentId: new URL(req.url).searchParams.get('intentId') })
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: ctx.auth!.tenantId, organizationId: ctx.selectedOrganizationId! }
    const intent = await em.findOne(PhysicalIntent, { id: q.intentId, ...scope } as never)
    if (!intent) return Response.json({ error: 'Not found' }, { status: 404 })
    const executions = await em.find(ExecutionRecord, { intentId: intent.id, ...scope } as never)
    const evidence = await em.find(EvidenceEnvelope, { intentId: intent.id, ...scope } as never)
    const diffs = await em.find(RealityDiff, { intentId: intent.id, ...scope } as never)
    return Response.json({
      intent: { id: intent.id, status: intent.status, selectedExecutorId: intent.selectedExecutorId, latestGate: intent.latestGateJson },
      executions: executions.map((x) => ({ id: x.id, status: x.status, outcomeCode: x.outcomeCode, failureCode: x.failureCode, executorId: x.executorId })),
      evidence: evidence.map((x) => ({ id: x.id, sourceKind: x.sourceKind, sourceId: x.sourceId, evidenceType: x.evidenceType, claim: x.claimJson, observedAt: x.observedAt })),
      diffs: diffs.map((x) => ({ id: x.id, status: x.status, effectAdapterKey: x.effectAdapterKey, proposedChange: x.proposedChangeJson, mergeResult: x.mergeResultJson, failureCode: x.failureCode })),
    })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400 }) }
}
export const openApi: OpenApiRouteDoc = { tag: 'Reality Layer', summary: 'Inspect Reality Layer causal chain', methods: {
  GET: { summary: 'Inspect Reality Layer causal chain', query: querySchema, responses: [{ status: 200, description: 'Intent status and provenance', schema: z.object({ intent: z.record(z.string(), z.unknown()), executions: z.array(z.record(z.string(), z.unknown())), evidence: z.array(z.record(z.string(), z.unknown())), diffs: z.array(z.record(z.string(), z.unknown())) }) }], errors: [{ status: 404, description: 'Intent not found', schema: z.object({ error: z.string() }) }] },
} }
