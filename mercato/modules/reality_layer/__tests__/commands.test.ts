import {
  cancelPhysicalIntentCommand,
  createPhysicalIntentCommand,
} from '../commands/intents'
import {
  grantPhysicalAuthorizationCommand,
  grantScopeDigest,
} from '../commands/authorization'
import { AuthorizationGrant, PhysicalIntent } from '../data/entities'

type Row = Record<string, unknown>

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const ORIGINATOR = '33333333-3333-4333-8333-333333333333'
const SUPERVISOR = '44444444-4444-4444-8444-444444444444'
const INTENT_ID = '55555555-5555-4555-8555-555555555555'
const CREATE_KEY = '66666666-6666-4666-8666-666666666666'
const GRANT_KEY = '77777777-7777-4777-8777-777777777777'

function makeIntent(overrides: Partial<PhysicalIntent> = {}): PhysicalIntent {
  return Object.assign(new PhysicalIntent(), {
    id: INTENT_ID,
    tenantId: TENANT,
    organizationId: ORG,
    kind: 'move_object',
    subjectKind: 'catalog_variant',
    subjectId: 'PART-17',
    sourceKind: 'wms_location',
    sourceId: 'STORAGE-A',
    destinationKind: 'wms_location',
    destinationId: 'REPAIR-BENCH',
    contextKind: null,
    contextId: null,
    parametersJson: { quantity: 1 },
    status: 'blocked',
    originatorUserId: ORIGINATOR,
    originatorKind: 'human',
    originContextJson: null,
    selectedExecutorId: null,
    latestGateJson: null,
    idempotencyKey: CREATE_KEY,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Partial<PhysicalIntent>)
}

function makeCtx(options: {
  actorId?: string
  actorKind?: 'human' | 'agent' | 'service'
  existingIntent?: PhysicalIntent | null
  existingGrant?: AuthorizationGrant | null
  selectedOrg?: string
} = {}) {
  const actorId = options.actorId ?? SUPERVISOR
  const actorKind = options.actorKind ?? 'human'
  const persisted: Row[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      const name = (entity as { name?: string })?.name ?? ''
      if (name === 'PhysicalIntent') {
        if (
          'idempotencyKey' in where &&
          options.existingIntent?.idempotencyKey === where.idempotencyKey
        ) {
          return options.existingIntent
        }
        if ('id' in where) return options.existingIntent ?? makeIntent()
        return null
      }
      if (name === 'AuthorizationGrant') return options.existingGrant ?? null
      return null
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const [index, row] of persisted.entries()) {
        if (!row.id) {
          row.id =
            row.__table === 'PhysicalIntent'
              ? INTENT_ID
              : '88888888-8888-4888-8888-888888888888'
        }
      }
    }),
  }

  const queryEngine = {
    query: jest.fn(async () => ({
      items: [{ id: actorId, kind: actorKind }],
      page: 1,
      pageSize: 1,
      total: 1,
    })),
  }

  return {
    persisted,
    em,
    queryEngine,
    ctx: {
      container: {
        resolve: (key: string) => (key === 'queryEngine' ? queryEngine : em),
      },
      auth: { sub: actorId, tenantId: TENANT, orgId: ORG },
      selectedOrganizationId: options.selectedOrg ?? ORG,
      organizationIds: [ORG],
      organizationScope: null,
    } as never,
  }
}

const createInput = {
  tenantId: TENANT,
  organizationId: ORG,
  kind: 'move_object' as const,
  subjectKind: 'catalog_variant',
  subjectId: 'PART-17',
  sourceKind: 'wms_location',
  sourceId: 'STORAGE-A',
  destinationKind: 'wms_location',
  destinationId: 'REPAIR-BENCH',
  parameters: { quantity: 1 },
  idempotencyKey: CREATE_KEY,
}

describe('reality_layer.intent.create', () => {
  it('creates a scoped pending intent with actor-derived provenance', async () => {
    const { ctx, persisted } = makeCtx({ actorId: ORIGINATOR })
    const result = await createPhysicalIntentCommand.execute(createInput, ctx)
    expect(result).toEqual({
      intentId: INTENT_ID,
      status: 'pending',
      idempotentReplay: false,
    })
    const row = persisted.find((item) => item.__table === 'PhysicalIntent')!
    expect(row.originatorUserId).toBe(ORIGINATOR)
    expect(row.originatorKind).toBe('human')
    expect(row.status).toBe('pending')
  })

  it('returns an identical request on idempotent replay', async () => {
    const { ctx } = makeCtx({ existingIntent: makeIntent({ status: 'pending' }) })
    const result = await createPhysicalIntentCommand.execute(createInput, ctx)
    expect(result.idempotentReplay).toBe(true)
    expect(result.intentId).toBe(INTENT_ID)
  })

  it('rejects a cross-organization command scope', async () => {
    const { ctx } = makeCtx({
      selectedOrg: '99999999-9999-4999-8999-999999999999',
    })
    await expect(createPhysicalIntentCommand.execute(createInput, ctx)).rejects.toThrow(
      /Cross-organization/,
    )
  })
})

describe('reality_layer.authorization.grant', () => {
  const grantInput = {
    tenantId: TENANT,
    organizationId: ORG,
    intentId: INTENT_ID,
    executorId: 'mock:cell-1',
    expiresAt: new Date(Date.now() + 60_000),
    idempotencyKey: GRANT_KEY,
  }

  it('derives scope from server-loaded intent data without authorizing the intent', async () => {
    const intent = makeIntent({ status: 'blocked' })
    const { ctx, persisted } = makeCtx({ existingIntent: intent })
    const result = await grantPhysicalAuthorizationCommand.execute(grantInput, ctx)
    const row = persisted.find((item) => item.__table === 'AuthorizationGrant')!
    expect(row.scopeDigest).toBe(grantScopeDigest(intent, grantInput.executorId))
    expect(row.actionKind).toBe('move_object')
    expect(row.destinationId).toBe('REPAIR-BENCH')
    expect(intent.status).toBe('blocked')
    expect(result.idempotentReplay).toBe(false)
  })

  it('rejects self-authorization by the intent originator', async () => {
    const { ctx } = makeCtx({ actorId: ORIGINATOR, existingIntent: makeIntent() })
    await expect(grantPhysicalAuthorizationCommand.execute(grantInput, ctx)).rejects.toThrow(
      /originator may not grant/,
    )
  })

  it('rejects agent/service grantors even if they reach the command path', async () => {
    const { ctx } = makeCtx({ actorKind: 'agent', existingIntent: makeIntent() })
    await expect(grantPhysicalAuthorizationCommand.execute(grantInput, ctx)).rejects.toThrow(
      /Only a human principal/,
    )
  })
})

describe('reality_layer.intent.cancel', () => {
  it('allows cancellation before dispatch', async () => {
    const intent = makeIntent({ status: 'authorized' })
    const { ctx } = makeCtx({ existingIntent: intent })
    const result = await cancelPhysicalIntentCommand.execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        intentId: INTENT_ID,
        reason: 'Operator withdrew request',
      },
      ctx,
    )
    expect(result.status).toBe('cancelled')
    expect(intent.status).toBe('cancelled')
  })

  it('refuses cancellation once physical execution is running', async () => {
    const { ctx } = makeCtx({ existingIntent: makeIntent({ status: 'executing' }) })
    await expect(
      cancelPhysicalIntentCommand.execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          intentId: INTENT_ID,
          reason: 'Too late',
        },
        ctx,
      ),
    ).rejects.toThrow(/Illegal PhysicalIntent transition/)
  })
})
