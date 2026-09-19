import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { PhysicalIntent, type PhysicalIntentStatus } from '../data/entities'
import { realityScopeSchema } from '../data/validators'
import { emitRealityLayerEvent } from '../events'
import { evaluateRealityGate } from '../lib/gate/evaluate'
import type { GateEvaluation } from '../lib/gate/types'
import { assertIntentTransition } from '../lib/stateMachine'
import { assertRealityScope, resolveRealityEm } from './shared'

export const gateEvaluateSchema = realityScopeSchema.extend({
  intentId: z.string().uuid(),
  executorId: z.string().trim().min(1).max(191),
})

export type GateEvaluateInput = z.infer<typeof gateEvaluateSchema>

export type GateEvaluateResult = {
  intentId: string
  executorId: string
  previousStatus: PhysicalIntentStatus
  status: PhysicalIntentStatus
  decision: GateEvaluation['decision']
  gate: GateEvaluation
}

const EVALUATABLE: ReadonlySet<PhysicalIntentStatus> = new Set([
  'pending',
  'blocked',
  'authorized',
])

export const evaluateRealityGateCommand: CommandHandler<
  GateEvaluateInput,
  GateEvaluateResult
> = {
  id: 'reality_layer.gate.evaluate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = gateEvaluateSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)

    const em = resolveRealityEm(ctx)
    const intent = await em.findOne(PhysicalIntent, {
      id: input.intentId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!intent) throw new Error('PhysicalIntent not found in the current scope.')
    if (!EVALUATABLE.has(intent.status)) {
      throw new Error(
        'Reality Gate cannot re-evaluate PhysicalIntent in status ' + intent.status + '.',
      )
    }

    const previousStatus = intent.status
    const gate = await evaluateRealityGate({
      em,
      ctx,
      intent,
      executorId: input.executorId,
    })
    const target: PhysicalIntentStatus =
      gate.decision === 'authorized' ? 'authorized' : 'blocked'

    if (intent.status !== target) {
      assertIntentTransition(intent.status, target)
      intent.status = target
    }
    intent.selectedExecutorId = input.executorId
    intent.latestGateJson = gate as unknown as Record<string, unknown>
    await em.flush()

    const eventId =
      target === 'authorized'
        ? 'reality_layer.intent.authorized'
        : 'reality_layer.intent.blocked'
    try {
      await emitRealityLayerEvent(eventId, {
        id: intent.id,
        intentId: intent.id,
        tenantId: intent.tenantId,
        organizationId: intent.organizationId,
        executorId: input.executorId,
        previousStatus,
        status: intent.status,
        gateDecision: gate.decision,
        gateCodes: gate.checks.map((check) => check.code),
      })
    } catch {
      // Domain state and ActionLog are authoritative. Broadcast failure must not
      // turn an already-persisted gate decision into a command failure.
    }

    return {
      intentId: intent.id,
      executorId: input.executorId,
      previousStatus,
      status: intent.status,
      decision: gate.decision,
      gate,
    }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Evaluate Reality Gate',
    resourceKind: 'reality_layer.intent',
    resourceId: result.intentId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: {
      executorId: input.executorId,
      previousStatus: result.previousStatus,
      status: result.status,
      decision: result.decision,
      checks: result.gate.checks.map((check) => ({
        name: check.name,
        state: check.state,
        code: check.code,
      })),
      grantId: result.gate.grantId,
    },
  }),
}

registerCommand(evaluateRealityGateCommand)
