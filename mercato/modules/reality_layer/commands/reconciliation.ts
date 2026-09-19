import { z } from 'zod'
import { registerCommand, type CommandBus, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { PhysicalIntent, RealityDiff } from '../data/entities'
import { realityScopeSchema } from '../data/validators'
import { emitRealityLayerEvent } from '../events'
import { sha256Canonical } from '../lib/canonical'
import { resolveRealityPrincipal } from '../lib/principal'
import { loadBusinessSnapshot } from '../lib/realityDiff'
import { assertDiffTransition, assertIntentTransition } from '../lib/stateMachine'
import { assertRealityScope, resolveRealityEm } from './shared'

const decisionSchema = realityScopeSchema.extend({
  diffId: z.string().uuid(),
  action: z.enum(['reject', 'request_more_evidence']),
  reason: z.string().trim().min(1).max(500),
})

const mergeSchema = realityScopeSchema.extend({
  diffId: z.string().uuid(),
})

const wmsEffectSchema = z.object({
  warehouseId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  quantity: z.number().positive(),
  lotId: z.string().uuid().optional(),
  serialNumber: z.string().trim().min(1).max(120).optional(),
})

async function requireHuman(ctx: Parameters<typeof resolveRealityPrincipal>[0], tenantId: string) {
  const principal = await resolveRealityPrincipal(ctx, tenantId)
  if (principal.kind !== 'human') {
    throw new Error('Only a human principal may decide RealityDiff reconciliation.')
  }
  return principal
}

export const decideRealityDiffCommand: CommandHandler<
  z.infer<typeof decisionSchema>,
  { diffId: string; status: string }
> = {
  id: 'reality_layer.reconciliation.decide',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = decisionSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)
    const principal = await requireHuman(ctx, input.tenantId)
    const em = resolveRealityEm(ctx)
    const diff = await em.findOne(RealityDiff, {
      id: input.diffId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!diff) throw new Error('RealityDiff not found in the current scope.')

    const target = input.action === 'reject' ? 'rejected' : 'needs_evidence'
    if (diff.status !== target) {
      assertDiffTransition(diff.status, target)
      diff.status = target
    }
    diff.decisionActorUserId = principal.userId
    diff.decidedAt = new Date()
    diff.failureCode = input.action === 'reject' ? 'rejected_by_human' : 'more_evidence_requested'
    diff.mergeResultJson = { reason: input.reason }
    await em.flush()
    return { diffId: diff.id, status: diff.status }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Decide RealityDiff',
    resourceKind: 'reality_layer.diff',
    resourceId: result.diffId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: { action: input.action, reason: input.reason, status: result.status },
  }),
}

export const mergeRealityDiffCommand: CommandHandler<
  z.infer<typeof mergeSchema>,
  { diffId: string; status: string; movementId?: string; stale?: boolean }
> = {
  id: 'reality_layer.reconciliation.merge',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = mergeSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)
    const principal = await requireHuman(ctx, input.tenantId)
    const em = resolveRealityEm(ctx)

    const diff = await em.findOne(RealityDiff, {
      id: input.diffId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!diff) throw new Error('RealityDiff not found in the current scope.')
    if (!['proposed', 'merge_failed', 'merging'].includes(diff.status)) {
      throw new Error('RealityDiff is not mergeable in status ' + diff.status + '.')
    }
    if (diff.effectAdapterKey !== 'wms_move' || diff.effectCommandId !== 'wms.inventory.move') {
      throw new Error('RealityDiff requires manual review and has no safe automatic ERP effect.')
    }

    const intent = await em.findOne(PhysicalIntent, {
      id: diff.intentId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!intent) throw new Error('RealityDiff intent is missing.')

    // On a retry from MERGING the downstream WMS command may already have
    // succeeded. Do not reject that retry because the WMS state has changed;
    // its own idempotency key (referenceId = diff.id) resolves the exact movement.
    if (diff.status !== 'merging') {
      const currentSnapshot = await loadBusinessSnapshot(em, intent)
      if (sha256Canonical(currentSnapshot) !== diff.businessVersionDigest) {
        assertDiffTransition(diff.status, 'needs_evidence')
        diff.status = 'needs_evidence'
        diff.failureCode = 'business_state_stale'
        diff.decisionActorUserId = principal.userId
        diff.decidedAt = new Date()
        await em.flush()
        return { diffId: diff.id, status: diff.status, stale: true }
      }

      assertDiffTransition(diff.status, 'merging')
      diff.status = 'merging'
      diff.decisionActorUserId = principal.userId
      diff.decidedAt = new Date()
      diff.failureCode = null
      await em.flush()
    }

    const effect = wmsEffectSchema.parse(diff.effectInputJson)
    const bus = ctx.container.resolve('commandBus') as CommandBus

    try {
      const response = await bus.execute('wms.inventory.move', {
        input: {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          warehouseId: effect.warehouseId,
          fromLocationId: effect.fromLocationId,
          toLocationId: effect.toLocationId,
          catalogVariantId: effect.catalogVariantId,
          lotId: effect.lotId,
          serialNumber: effect.serialNumber,
          quantity: effect.quantity,
          type: 'transfer',
          reason: 'Reality Layer accepted physical reconciliation',
          referenceType: 'manual',
          referenceId: diff.id,
          performedBy: principal.userId,
          metadata: {
            realityIntentId: intent.id,
            realityExecutionId: diff.executionId,
            realityDiffId: diff.id,
          },
        },
        ctx,
      })
      const result = response.result as { movementId?: string }
      if (!result?.movementId) throw new Error('WMS move returned no movement id.')

      assertDiffTransition(diff.status, 'merged')
      diff.status = 'merged'
      diff.mergeResultJson = { movementId: result.movementId }
      diff.failureCode = null
      if (intent.status === 'executed') {
        assertIntentTransition(intent.status, 'closed')
        intent.status = 'closed'
      }
      await em.flush()

      try {
        await emitRealityLayerEvent('reality_layer.diff.merged', {
          id: diff.id,
          diffId: diff.id,
          intentId: intent.id,
          executionId: diff.executionId,
          movementId: result.movementId,
          tenantId: input.tenantId,
          organizationId: input.organizationId,
        })
      } catch {}

      return { diffId: diff.id, status: diff.status, movementId: result.movementId }
    } catch {
      if (diff.status === 'merging') {
        assertDiffTransition(diff.status, 'merge_failed')
        diff.status = 'merge_failed'
      }
      diff.failureCode = 'wms_merge_failed'
      await em.flush()
      return { diffId: diff.id, status: diff.status }
    }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Merge RealityDiff into ERP truth',
    resourceKind: 'reality_layer.diff',
    resourceId: result.diffId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: { status: result.status, movementId: result.movementId, stale: result.stale },
  }),
}

registerCommand(decideRealityDiffCommand)
registerCommand(mergeRealityDiffCommand)
