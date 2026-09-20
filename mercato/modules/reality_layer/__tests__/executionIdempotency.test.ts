import { ExecutionRecord } from '../data/entities'
import { dispatchPhysicalExecutionCommand } from '../commands/execution'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const INTENT = '33333333-3333-4333-8333-333333333333'
const EXECUTION = '44444444-4444-4444-8444-444444444444'
const DISPATCH = '55555555-5555-4555-8555-555555555555'

function makeCtx(existingScenario: 'success' | 'failure' | 'unexpected_result') {
  const existing = Object.assign(new ExecutionRecord(), {
    id: EXECUTION,
    tenantId: TENANT,
    organizationId: ORG,
    intentId: INTENT,
    executorId: 'mock:cell-1',
    attemptNo: 1,
    dispatchKey: DISPATCH,
    status: 'queued',
    executorMetadataJson: { mockScenario: existingScenario },
  })

  const em = {
    fork: () => em,
    findOne: jest.fn(async (Entity: unknown) =>
      Entity === ExecutionRecord ? existing : null,
    ),
  }

  return {
    ctx: {
      container: {
        resolve: (key: string) => {
          if (key === 'em') return em
          throw new Error('Unexpected service: ' + key)
        },
      },
      auth: {
        sub: '66666666-6666-4666-8666-666666666666',
        tenantId: TENANT,
        orgId: ORG,
      },
      selectedOrganizationId: ORG,
    } as never,
  }
}

const input = {
  tenantId: TENANT,
  organizationId: ORG,
  intentId: INTENT,
  executorId: 'mock:cell-1',
  dispatchKey: DISPATCH,
  mockScenario: 'success' as const,
}

describe('Reality Layer execution dispatch idempotency', () => {
  it('accepts an identical dispatch-key replay', async () => {
    const { ctx } = makeCtx('success')
    await expect(dispatchPhysicalExecutionCommand.execute(input, ctx)).resolves.toEqual({
      executionId: EXECUTION,
      status: 'queued',
      idempotentReplay: true,
    })
  })

  it('rejects the same dispatch key when execution semantics differ', async () => {
    const { ctx } = makeCtx('success')
    await expect(
      dispatchPhysicalExecutionCommand.execute(
        { ...input, mockScenario: 'failure' },
        ctx,
      ),
    ).rejects.toThrow(/different request/)
  })
})
