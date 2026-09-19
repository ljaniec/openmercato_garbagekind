import { createModuleQueue, type Queue } from '@open-mercato/queue'
import type { MockScenario } from './executors/types'

export const REALITY_EXECUTION_QUEUE = 'reality-layer-execution'

export type RealityExecutionJob = {
  executionId: string
  tenantId: string
  organizationId: string
  mockScenario: MockScenario
}

let queue: Queue<RealityExecutionJob> | null = null

export function getRealityExecutionQueue(): Queue<RealityExecutionJob> {
  if (queue) return queue
  queue = createModuleQueue<RealityExecutionJob>(REALITY_EXECUTION_QUEUE, {
    concurrency: 2,
    attempts: 3,
  })
  return queue
}
