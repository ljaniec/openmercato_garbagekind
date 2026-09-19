export type MockScenario = 'success' | 'failure' | 'unexpected_result'

export type EvidenceInput = Readonly<{
  sourceKind: 'executor' | 'camera' | 'vlm' | 'human' | 'other'
  sourceId: string
  evidenceType: 'task_completion_observation' | 'object_location'
  observedAt: string
  claim: Readonly<Record<string, unknown>>
  confidence?: number
  externalEventId: string
  provenance?: Readonly<Record<string, unknown>>
}>

export type AuthorizedPhysicalTask = Readonly<{
  intentId: string
  executionId: string
  executorId: string
  kind: 'move_object'
  subject: Readonly<{ kind: string; id: string }>
  source: Readonly<{ kind: string; id: string }>
  destination: Readonly<{ kind: string; id: string }>
  parameters: Readonly<Record<string, unknown>>
  scenario: MockScenario
}>

export type ExecutionResult = Readonly<{
  outcome: 'success' | 'failure' | 'unexpected_result'
  externalExecutionId: string
  failureCode?: string
  evidence: readonly EvidenceInput[]
}>

export interface PhysicalExecutor {
  readonly executorKind: string
  canHandle(executorId: string): boolean
  execute(task: AuthorizedPhysicalTask, idempotencyKey: string): Promise<ExecutionResult>
}
