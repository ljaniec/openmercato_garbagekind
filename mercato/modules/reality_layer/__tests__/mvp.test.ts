import { PhysicalIntent, RealityDiff } from '../data/entities'
import { mergeRealityDiffCommand } from '../commands/reconciliation'
import { mockExecutor } from '../lib/executors/mock'
import { buildRealityDiff } from '../lib/realityDiff'
import { sha256Canonical } from '../lib/canonical'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const INTENT_ID = '33333333-3333-4333-8333-333333333333'
const EXECUTION_ID = '44444444-4444-4444-8444-444444444444'
const DIFF_ID = '55555555-5555-4555-8555-555555555555'
const USER = '66666666-6666-4666-8666-666666666666'
const WAREHOUSE = '77777777-7777-4777-8777-777777777777'
const SOURCE = '88888888-8888-4888-8888-888888888888'
const DEST = '99999999-9999-4999-8999-999999999999'
const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function intent(overrides: Partial<PhysicalIntent> = {}): PhysicalIntent {
  return Object.assign(new PhysicalIntent(), {
    id: INTENT_ID,
    tenantId: TENANT,
    organizationId: ORG,
    kind: 'move_object',
    subjectKind: 'catalog_variant',
    subjectId: VARIANT,
    sourceKind: 'wms_location',
    sourceId: SOURCE,
    destinationKind: 'wms_location',
    destinationId: DEST,
    parametersJson: { warehouseId: WAREHOUSE, quantity: 1 },
    status: 'executed',
    originatorUserId: null,
    originatorKind: 'agent',
    selectedExecutorId: 'mock:cell-1',
    latestGateJson: null,
    idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Partial<PhysicalIntent>)
}

describe('MockExecutor MVP contract', () => {
  it('reports requested destination on success', async () => {
    const result = await mockExecutor.execute(
      {
        intentId: INTENT_ID,
        executionId: EXECUTION_ID,
        executorId: 'mock:cell-1',
        kind: 'move_object',
        subject: { kind: 'asset', id: 'box-1' },
        source: { kind: 'cell', id: 'A' },
        destination: { kind: 'cell', id: 'B' },
        parameters: {},
        scenario: 'success',
      },
      'dispatch-1',
    )
    expect(result.outcome).toBe('success')
    expect(result.evidence[0].claim.location).toEqual({ kind: 'cell', id: 'B' })
  })

  it('does not disguise an unexpected physical destination as success-at-target', async () => {
    const result = await mockExecutor.execute(
      {
        intentId: INTENT_ID,
        executionId: EXECUTION_ID,
        executorId: 'mock:cell-1',
        kind: 'move_object',
        subject: { kind: 'asset', id: 'box-1' },
        source: { kind: 'cell', id: 'A' },
        destination: { kind: 'cell', id: 'B' },
        parameters: { mockUnexpectedDestinationId: 'C' },
        scenario: 'unexpected_result',
      },
      'dispatch-2',
    )
    expect(result.outcome).toBe('unexpected_result')
    expect(result.evidence[0].claim.location).toEqual({ kind: 'cell', id: 'C' })
  })
})

describe('RealityDiff effect classification', () => {
  it('creates a WMS effect only when evidence matches the intended destination', async () => {
    const row = intent()
    const created: unknown[] = []
    const em = {
      findOne: jest.fn(async () => null),
      getConnection: () => ({ execute: jest.fn(async () => [{ available: '5' }]) }),
      create: jest.fn((Entity: new () => unknown, data: Record<string, unknown>) => {
        const entity = Object.assign(new Entity(), data, { id: DIFF_ID })
        created.push(entity)
        return entity
      }),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    } as never
    const evidence = [{
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      claimJson: { location: { kind: 'wms_location', id: DEST } },
    }] as never
    const diff = await buildRealityDiff(em, row, EXECUTION_ID, evidence)
    expect(diff?.effectAdapterKey).toBe('wms_move')
    expect(diff?.effectCommandId).toBe('wms.inventory.move')
  })

  it('forces manual review when evidence says the object ended elsewhere', async () => {
    const row = intent()
    const em = {
      findOne: jest.fn(async () => null),
      getConnection: () => ({ execute: jest.fn(async () => [{ available: '5' }]) }),
      create: jest.fn((Entity: new () => unknown, data: Record<string, unknown>) =>
        Object.assign(new Entity(), data, { id: DIFF_ID }),
      ),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    } as never
    const evidence = [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      claimJson: { location: { kind: 'wms_location', id: SOURCE } },
    }] as never
    const diff = await buildRealityDiff(em, row, EXECUTION_ID, evidence)
    expect(diff?.effectAdapterKey).toBe('manual_review')
    expect(diff?.proposedChangeJson).toMatchObject({ manualReview: true })
  })
})

describe('human reconciliation', () => {
  it('retries MERGING through WMS with diff id as the idempotency reference', async () => {
    const row = intent({ status: 'executed' })
    const diff = Object.assign(new RealityDiff(), {
      id: DIFF_ID,
      tenantId: TENANT,
      organizationId: ORG,
      intentId: INTENT_ID,
      executionId: EXECUTION_ID,
      status: 'merging',
      businessBeforeJson: {},
      businessVersionDigest: sha256Canonical({}),
      observedJson: {},
      proposedChangeJson: {},
      evidenceIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
      effectAdapterKey: 'wms_move',
      effectCommandId: 'wms.inventory.move',
      effectInputJson: {
        warehouseId: WAREHOUSE,
        fromLocationId: SOURCE,
        toLocationId: DEST,
        catalogVariantId: VARIANT,
        quantity: 1,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Partial<RealityDiff>)

    const wmsExecute = jest.fn(async () => ({
      result: { movementId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    }))
    const em = {
      fork: () => em,
      findOne: jest.fn(async (Entity: { name?: string }) =>
        Entity.name === 'RealityDiff' ? diff : row,
      ),
      flush: jest.fn(async () => undefined),
    }
    const queryEngine = {
      query: jest.fn(async () => ({ items: [{ id: USER, kind: 'human' }] })),
    }
    const ctx = {
      container: {
        resolve: (key: string) => {
          if (key === 'em') return em
          if (key === 'queryEngine') return queryEngine
          if (key === 'commandBus') return { execute: wmsExecute }
          throw new Error('unknown service ' + key)
        },
      },
      auth: { sub: USER, tenantId: TENANT, orgId: ORG },
      selectedOrganizationId: ORG,
    } as never

    const result = await mergeRealityDiffCommand.execute(
      { tenantId: TENANT, organizationId: ORG, diffId: DIFF_ID },
      ctx,
    )
    expect(result.status).toBe('merged')
    expect(row.status).toBe('closed')
    expect(diff.status).toBe('merged')
    expect(wmsExecute).toHaveBeenCalledTimes(1)
    expect(wmsExecute.mock.calls[0][1].input.referenceId).toBe(DIFF_ID)
  })
})
