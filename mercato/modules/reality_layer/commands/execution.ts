import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { ExecutionRecord, PhysicalIntent } from '../data/entities'
import { realityScopeSchema } from '../data/validators'
import { assertExecutionTransition, assertIntentTransition } from '../lib/stateMachine'
import { getRealityExecutionQueue } from '../lib/queue'
import { assertRealityScope, resolveRealityEm } from './shared'

const mockScenarioSchema = z.enum(['success', 'failure', 'unexpected_result'])

export const dispatchExecutionSchema = realityScopeSchema.extend({
  intentId: z.string().uuid(),
  executorId: z.string().trim().min(1).max(191),
  dispatchKey: z.string().uuid(),
  mockScenario: mockScenarioSchema.default('success'),
})

export type DispatchExecutionInput = z.infer<typeof dispatchExecutionSchema>

export const dispatchPhysicalExecutionCommand: CommandHandler<
  DispatchExecutionInput,
  { executionId: string; status: string; idempotentReplay: boolean }
> = {
  id: 'reality_layer.execution.dispatch',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = dispatchExecutionSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)
    if (!input.executorId.startsWith('mock:')) {
      throw new Error('MVP execution supports only mock:<id> executors.')
    }

    const em = resolveRealityEm(ctx)
    const existing = await em.findOne(ExecutionRecord, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      dispatchKey: input.dispatchKey,
    } as never)
    if (existing) {
      const existingScenario =
        (existing.executorMetadataJson as { mockScenario?: unknown } | null)?.mockScenario ?? 'success'
      if (
        existing.intentId !== input.intentId ||
        existing.executorId !== input.executorId ||
        existingScenario !== input.mockScenario
      ) {
        throw new Error('Execution dispatch key was already used for a different request.')
      }
      return { executionId: existing.id, status: existing.status, idempotentReplay: true }
    }

    const intent = await em.findOne(PhysicalIntent, {
      id: input.intentId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!intent) throw new Error('PhysicalIntent not found in the current scope.')
    if (intent.status !== 'authorized') {
      throw new Error('PhysicalIntent must be AUTHORIZED before dispatch.')
    }
    if (intent.selectedExecutorId !== input.executorId) {
      throw new Error('Dispatch executor does not match the executor authorized by the latest gate.')
    }

    const attempts = await em.find(ExecutionRecord, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      intentId: input.intentId,
    } as never)
    const attemptNo = attempts.reduce((max, row) => Math.max(max, row.attemptNo), 0) + 1

    const execution = em.create(ExecutionRecord, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      intentId: intent.id,
      executorId: input.executorId,
      attemptNo,
      dispatchKey: input.dispatchKey,
      status: 'queued',
      executorMetadataJson: { mockScenario: input.mockScenario },
    } as never)
    em.persist(execution)
    await em.flush()

    assertIntentTransition(intent.status, 'dispatched')
    intent.status = 'dispatched'
    await em.flush()

    try {
      await getRealityExecutionQueue().enqueue({
        executionId: execution.id,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        mockScenario: input.mockScenario,
      })
    } catch (error) {
      assertExecutionTransition(execution.status, 'failed')
      execution.status = 'failed'
      execution.failureCode = 'queue_enqueue_failed'
      execution.finishedAt = new Date()
      assertIntentTransition(intent.status, 'authorized')
      intent.status = 'authorized'
      await em.flush()
      throw error
    }

    return { executionId: execution.id, status: execution.status, idempotentReplay: false }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Dispatch physical execution',
    resourceKind: 'reality_layer.execution',
    resourceId: result.executionId,
    relatedResourceKind: 'reality_layer.intent',
    relatedResourceId: input.intentId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: {
      executorId: input.executorId,
      dispatchKey: input.dispatchKey,
      mockScenario: input.mockScenario,
      idempotentReplay: result.idempotentReplay,
    },
  }),
}

registerCommand(dispatchPhysicalExecutionCommand)
