import { AuthorizationGrant, PhysicalIntent } from '../data/entities'
import { grantScopeDigest } from '../commands/authorization'
import { evaluateRealityGateCommand } from '../commands/gate'
import {
  evaluateBusinessPrecondition,
  evaluateExecutorCredential,
} from '../lib/gate/providers'
import { finalizeGate, gateCheck } from '../lib/gate/types'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const INTENT_ID = '33333333-3333-4333-8333-333333333333'
const GRANT_ID = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'
const SOURCE = '66666666-6666-4666-8666-666666666666'
const DEST = '77777777-7777-4777-8777-777777777777'
const VARIANT = '88888888-8888-4888-8888-888888888888'

function makeIntent(overrides: Partial<PhysicalIntent> = {}): PhysicalIntent {
  return Object.assign(new PhysicalIntent(), {
    id: INTENT_ID,
    tenantId: TENANT,
    organizationId: ORG,
    kind: 'move_object',
    subjectKind: 'asset',
    subjectId: 'box-17',
    sourceKind: 'cell',
    sourceId: 'cell-a',
    destinationKind: 'cell',
    destinationId: 'cell-b',
    contextKind: null,
    contextId: null,
    parametersJson: {},
    status: 'blocked',
    originatorUserId: USER,
    originatorKind: 'human',
    selectedExecutorId: null,
    latestGateJson: null,
    idempotencyKey: '99999999-9999-4999-8999-999999999999',
    createdAt: new Date('2026-09-19T12:00:00Z'),
    updatedAt: new Date('2026-09-19T12:00:00Z'),
    ...overrides,
  } as Partial<PhysicalIntent>)
}

function makeGrant(forIntent: PhysicalIntent, expiresAt: Date): AuthorizationGrant {
  return Object.assign(new AuthorizationGrant(), {
    id: GRANT_ID,
    tenantId: TENANT,
    organizationId: ORG,
    intentId: forIntent.id,
    executorId: 'mock:cell-1',
    actionKind: forIntent.kind,
    destinationKind: forIntent.destinationKind,
    destinationId: forIntent.destinationId,
    grantedByUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scopeDigest: grantScopeDigest(forIntent, 'mock:cell-1'),
    expiresAt,
    revokedAt: null,
    idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: new Date('2026-09-19T11:00:00Z'),
  } as Partial<AuthorizationGrant>)
}

function commandContext(row: PhysicalIntent, grants: AuthorizationGrant[]) {
  const em = {
    fork: () => em,
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => grants),
    flush: jest.fn(async () => undefined),
    getConnection: () => ({
      execute: jest.fn(async () => {
        throw new Error('MockExecutor gate must not query peer-module tables.')
      }),
    }),
  }
  const commandBus = { execute: jest.fn() }
  const ctx = {
    container: {
      resolve: (key: string) => (key === 'commandBus' ? commandBus : em),
    },
    auth: { sub: USER, tenantId: TENANT, orgId: ORG },
    selectedOrganizationId: ORG,
  } as never
  return { em, ctx }
}

describe('Reality Gate combination', () => {
  it('authorizes only when every independent check passes', () => {
    const checks = [
      gateCheck('business_precondition', 'pass', 'a', 'ok'),
      gateCheck('executor_capability', 'pass', 'b', 'ok'),
      gateCheck('executor_credential', 'pass', 'c', 'ok'),
      gateCheck('authorization_grant', 'pass', 'd', 'ok'),
      gateCheck('deterministic_policy', 'pass', 'e', 'ok'),
    ]
    expect(
      finalizeGate(
        'mock:x',
        new Date('2026-09-19T12:00:00Z'),
        checks,
        GRANT_ID,
      ).decision,
    ).toBe('authorized')
  })

  it('treats unknown exactly as fail-closed blocked', () => {
    const checks = [
      gateCheck('business_precondition', 'pass', 'a', 'ok'),
      gateCheck('executor_capability', 'unknown', 'payload_unknown', 'unknown'),
      gateCheck('executor_credential', 'pass', 'c', 'ok'),
      gateCheck('authorization_grant', 'pass', 'd', 'ok'),
      gateCheck('deterministic_policy', 'pass', 'e', 'ok'),
    ]
    expect(finalizeGate('robot:x', new Date(), checks, GRANT_ID).decision).toBe('blocked')
  })
})

describe('reality_layer.gate.evaluate with MockExecutor', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-19T12:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('moves BLOCKED to AUTHORIZED when all live checks pass', async () => {
    const row = makeIntent({ status: 'blocked' })
    const { ctx } = commandContext(
      row,
      [makeGrant(row, new Date('2026-09-19T13:00:00Z'))],
    )
    const result = await evaluateRealityGateCommand.execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        intentId: INTENT_ID,
        executorId: 'mock:cell-1',
      },
      ctx,
    )
    expect(result.decision).toBe('authorized')
    expect(result.status).toBe('authorized')
    expect(row.status).toBe('authorized')
    expect(row.selectedExecutorId).toBe('mock:cell-1')
    expect(result.gate.checks).toHaveLength(5)
    expect(result.gate.checks.every((check) => check.state === 'pass')).toBe(true)
  })

  it('blocks when no human authorization grant exists', async () => {
    const row = makeIntent({ status: 'pending' })
    const { ctx } = commandContext(row, [])
    const result = await evaluateRealityGateCommand.execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        intentId: INTENT_ID,
        executorId: 'mock:cell-1',
      },
      ctx,
    )
    expect(result.decision).toBe('blocked')
    expect(result.status).toBe('blocked')
    expect(
      result.gate.checks.find((check) => check.name === 'authorization_grant')?.code,
    ).toBe('grant_missing')
  })

  it('moves AUTHORIZED back to BLOCKED if the grant expires before dispatch', async () => {
    const row = makeIntent({ status: 'authorized' })
    const { ctx } = commandContext(
      row,
      [makeGrant(row, new Date('2026-09-19T11:59:59Z'))],
    )
    const result = await evaluateRealityGateCommand.execute(
      {
        tenantId: TENANT,
        organizationId: ORG,
        intentId: INTENT_ID,
        executorId: 'mock:cell-1',
      },
      ctx,
    )
    expect(result.decision).toBe('blocked')
    expect(result.previousStatus).toBe('authorized')
    expect(result.status).toBe('blocked')
    expect(
      result.gate.checks.find((check) => check.name === 'authorization_grant')?.code,
    ).toBe('grant_expired')
  })

  it('does not re-evaluate after physical execution has started', async () => {
    const row = makeIntent({ status: 'executing' })
    const { ctx } = commandContext(row, [])
    await expect(
      evaluateRealityGateCommand.execute(
        {
          tenantId: TENANT,
          organizationId: ORG,
          intentId: INTENT_ID,
          executorId: 'mock:cell-1',
        },
        ctx,
      ),
    ).rejects.toThrow(/cannot re-evaluate/)
  })
})

describe('business precondition provider', () => {
  it('rejects source equal to destination before touching WMS', async () => {
    const row = makeIntent({ sourceId: 'same', destinationId: 'same' })
    const execute = jest.fn()
    const em = { getConnection: () => ({ execute }) } as never
    const check = await evaluateBusinessPrecondition(em, {
      intent: row,
      executorId: 'mock:x',
      now: new Date(),
    })
    expect(check.code).toBe('source_equals_destination')
    expect(check.state).toBe('block')
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses current WMS available quantity rather than on-hand alone', async () => {
    const row = makeIntent({
      subjectKind: 'catalog_variant',
      subjectId: VARIANT,
      sourceKind: 'wms_location',
      sourceId: SOURCE,
      destinationKind: 'wms_location',
      destinationId: DEST,
      parametersJson: { quantity: 3 },
    })
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ id: SOURCE }, { id: DEST }])
      .mockResolvedValueOnce([{ available: '2.5' }])
    const em = { getConnection: () => ({ execute }) } as never
    const check = await evaluateBusinessPrecondition(em, {
      intent: row,
      executorId: 'mock:x',
      now: new Date(),
    })
    expect(check.code).toBe('wms_insufficient_available')
    expect(check.details).toEqual({ requested: 3, available: 2.5 })
  })
})

describe('Edge credential provider', () => {
  it('blocks a new dispatch when heartbeat is outside the online window', async () => {
    const row = makeIntent()
    const execute = jest.fn(async () => [
      {
        id: 'agent-1',
        status: 'enrolled',
        last_seen_at: '2026-09-19T11:59:40Z',
        heartbeat_interval_seconds: 5,
        liveness_grace_seconds: 5,
        lost_after_seconds: 60,
        valid_key: true,
      },
    ])
    const em = { getConnection: () => ({ execute }) } as never
    const check = await evaluateExecutorCredential(em, {
      intent: row,
      executorId: 'robot:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      now: new Date('2026-09-19T12:00:00Z'),
    })
    expect(check.state).toBe('block')
    expect(check.code).toBe('edge_late')
  })
})
