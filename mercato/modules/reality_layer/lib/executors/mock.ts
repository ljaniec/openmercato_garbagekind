import type { AuthorizedPhysicalTask, ExecutionResult, PhysicalExecutor } from './types'

export class MockExecutor implements PhysicalExecutor {
  readonly executorKind = 'mock'

  canHandle(executorId: string): boolean {
    return executorId.startsWith('mock:') && executorId.length > 5
  }

  async execute(task: AuthorizedPhysicalTask, idempotencyKey: string): Promise<ExecutionResult> {
    const observedAt = new Date().toISOString()
    const externalExecutionId = 'mock:' + idempotencyKey

    if (task.scenario === 'failure') {
      return {
        outcome: 'failure',
        externalExecutionId,
        failureCode: 'mock_execution_failed',
        evidence: [],
      }
    }

    const destination =
      task.scenario === 'unexpected_result'
        ? {
            kind: task.destination.kind,
            id:
              typeof task.parameters.mockUnexpectedDestinationId === 'string'
                ? task.parameters.mockUnexpectedDestinationId
                : 'mock-unexpected-destination',
          }
        : task.destination

    return {
      outcome: task.scenario,
      externalExecutionId,
      evidence: [
        {
          sourceKind: 'executor',
          sourceId: task.executorId,
          evidenceType: 'object_location',
          observedAt,
          claim: {
            subject: task.subject,
            location: destination,
            completed: true,
          },
          confidence: 1,
          externalEventId: task.executionId + ':result',
          provenance: { adapter: 'MockExecutor', scenario: task.scenario },
        },
      ],
    }
  }
}

export const mockExecutor = new MockExecutor()
