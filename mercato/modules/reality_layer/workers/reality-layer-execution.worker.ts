import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { ExecutionRecord, PhysicalIntent } from '../data/entities'
import { emitRealityLayerEvent } from '../events'
import { mockExecutor } from '../lib/executors/mock'
import type { AuthorizedPhysicalTask, MockScenario } from '../lib/executors/types'
import { recordEvidence } from '../lib/evidence'
import { evaluateRealityGate } from '../lib/gate/evaluate'
import { buildRealityDiff } from '../lib/realityDiff'
import { REALITY_EXECUTION_QUEUE, type RealityExecutionJob } from '../lib/queue'
import { assertExecutionTransition, assertIntentTransition } from '../lib/stateMachine'

export const metadata: WorkerMeta = {
  queue: REALITY_EXECUTION_QUEUE,
  id: 'reality-layer:execution',
  concurrency: 2,
}

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

function mockScenario(value: unknown): MockScenario {
  return value === 'failure' || value === 'unexpected_result' ? value : 'success'
}

function commandContext(
  ctx: HandlerContext,
  tenantId: string,
  organizationId: string,
  userId: string | null,
): CommandRuntimeContext {
  return {
    container: { resolve: (name: string) => ctx.resolve(name) } as never,
    auth: { tenantId, orgId: organizationId, sub: userId ?? undefined } as never,
    selectedOrganizationId: organizationId,
    organizationIds: [organizationId],
    organizationScope: null,
  } as never
}

async function emitFinished(intent: PhysicalIntent, execution: ExecutionRecord): Promise<void> {
  try {
    await emitRealityLayerEvent('reality_layer.execution.finished', {
      id: execution.id,
      executionId: execution.id,
      intentId: intent.id,
      status: execution.status,
      outcomeCode: execution.outcomeCode,
      failureCode: execution.failureCode,
      tenantId: intent.tenantId,
      organizationId: intent.organizationId,
    })
  } catch {
    // Domain rows remain authoritative.
  }
}

export default async function handle(
  job: QueuedJob<RealityExecutionJob>,
  ctx: HandlerContext,
): Promise<void> {
  const rootEm = ctx.resolve<EntityManager>('em')
  const em = rootEm.fork()
  const execution = await em.findOne(ExecutionRecord, {
    id: job.payload.executionId,
    tenantId: job.payload.tenantId,
    organizationId: job.payload.organizationId,
  } as never)
  if (!execution) return
  if (['succeeded', 'failed', 'timed_out', 'abandoned'].includes(execution.status)) return

  const intent = await em.findOne(PhysicalIntent, {
    id: execution.intentId,
    tenantId: execution.tenantId,
    organizationId: execution.organizationId,
  } as never)
  if (!intent) {
    if (execution.status === 'queued') {
      assertExecutionTransition(execution.status, 'failed')
      execution.status = 'failed'
      execution.failureCode = 'intent_missing'
      execution.finishedAt = new Date()
      await em.flush()
    }
    return
  }

  if (execution.status === 'queued') {
    const gate = await evaluateRealityGate({
      em,
      ctx: commandContext(ctx, intent.tenantId, intent.organizationId, intent.originatorUserId ?? null),
      intent,
      executorId: execution.executorId,
    })
    intent.latestGateJson = gate as unknown as Record<string, unknown>
    if (gate.decision !== 'authorized') {
      assertExecutionTransition(execution.status, 'failed')
      execution.status = 'failed'
      execution.failureCode = 'pre_start_gate_blocked'
      execution.finishedAt = new Date()
      if (intent.status === 'dispatched') {
        assertIntentTransition(intent.status, 'blocked')
        intent.status = 'blocked'
      }
      await em.flush()
      await emitFinished(intent, execution)
      return
    }

    assertExecutionTransition(execution.status, 'started')
    execution.status = 'started'
    execution.startedAt = new Date()
    if (intent.status !== 'dispatched') {
      execution.status = 'failed'
      execution.failureCode = 'intent_not_dispatched'
      execution.finishedAt = new Date()
      await em.flush()
      await emitFinished(intent, execution)
      return
    }
    assertIntentTransition(intent.status, 'executing')
    intent.status = 'executing'
    await em.flush()
  }

  if (!mockExecutor.canHandle(execution.executorId)) {
    assertExecutionTransition(execution.status, 'failed')
    execution.status = 'failed'
    execution.failureCode = 'executor_adapter_missing'
    execution.finishedAt = new Date()
    if (intent.status === 'executing') {
      assertIntentTransition(intent.status, 'failed')
      intent.status = 'failed'
    }
    await em.flush()
    await emitFinished(intent, execution)
    return
  }

  const task: AuthorizedPhysicalTask = {
    intentId: intent.id,
    executionId: execution.id,
    executorId: execution.executorId,
    kind: 'move_object',
    subject: { kind: intent.subjectKind, id: intent.subjectId },
    source: { kind: intent.sourceKind ?? 'unknown', id: intent.sourceId ?? 'unknown' },
    destination: { kind: intent.destinationKind, id: intent.destinationId },
    parameters: intent.parametersJson ?? {},
    scenario: mockScenario(execution.executorMetadataJson?.mockScenario ?? job.payload.mockScenario),
  }

  const result = await mockExecutor.execute(task, execution.dispatchKey)
  execution.externalExecutionId = result.externalExecutionId
  execution.outcomeCode = result.outcome
  execution.finishedAt = new Date()

  if (result.outcome === 'failure') {
    assertExecutionTransition(execution.status, 'failed')
    execution.status = 'failed'
    execution.failureCode = result.failureCode ?? 'execution_failed'
    if (intent.status === 'executing') {
      assertIntentTransition(intent.status, 'failed')
      intent.status = 'failed'
    }
    await em.flush()
    await emitFinished(intent, execution)
    return
  }

  assertExecutionTransition(execution.status, 'succeeded')
  execution.status = 'succeeded'
  if (intent.status === 'executing') {
    assertIntentTransition(intent.status, 'executed')
    intent.status = 'executed'
  }
  await em.flush()

  const evidence = await recordEvidence(
    em,
    {
      tenantId: intent.tenantId,
      organizationId: intent.organizationId,
      intentId: intent.id,
      executionId: execution.id,
    },
    result.evidence,
  )
  const diff = await buildRealityDiff(em, intent, execution.id, evidence)

  if (evidence.length) {
    try {
      await emitRealityLayerEvent('reality_layer.evidence.recorded', {
        id: evidence[0].id,
        intentId: intent.id,
        executionId: execution.id,
        evidenceIds: evidence.map((item) => item.id),
        tenantId: intent.tenantId,
        organizationId: intent.organizationId,
      })
    } catch {}
  }
  if (diff) {
    try {
      await emitRealityLayerEvent('reality_layer.diff.proposed', {
        id: diff.id,
        intentId: intent.id,
        executionId: execution.id,
        status: diff.status,
        effectAdapterKey: diff.effectAdapterKey,
        tenantId: intent.tenantId,
        organizationId: intent.organizationId,
      })
    } catch {}
  }
  await emitFinished(intent, execution)
}
