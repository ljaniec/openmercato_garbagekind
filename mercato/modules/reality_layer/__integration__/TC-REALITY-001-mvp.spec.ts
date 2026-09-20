import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createProductFixture,
  createVariantFixture,
  deleteCatalogProductIfExists,
} from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  deleteGeneralEntityIfExists,
  getTokenScope,
} from '@open-mercato/core/helpers/integration/generalFixtures'

export const integrationMeta = {
  dependsOnModules: ['reality_layer', 'wms', 'catalog'],
}

type RealityStatus = {
  intent: {
    id: string
    status: string
    selectedExecutorId?: string | null
    latestGate?: unknown
  }
  executions: Array<{
    id: string
    status: string
    outcomeCode?: string | null
    failureCode?: string | null
    executorId: string
  }>
  evidence: Array<{
    id: string
    sourceKind: string
    sourceId: string
    evidenceType: string
    claim: Record<string, unknown>
    observedAt: string
  }>
  diffs: Array<{
    id: string
    status: string
    effectAdapterKey: string
    proposedChange?: Record<string, unknown>
    mergeResult?: Record<string, unknown> | null
    failureCode?: string | null
  }>
}

async function readJson<T>(response: APIResponse): Promise<T> {
  const text = await response.text()
  if (!text) throw new Error('Expected JSON response body, got empty response')
  return JSON.parse(text) as T
}

async function postJson<T>(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
  expectedStatus: number,
): Promise<T> {
  const response = await apiRequest(request, 'POST', path, { token, data })
  const body = await readJson<T & { error?: string }>(response)
  expect(
    response.status(),
    `${path} failed: ${(body as { error?: string }).error ?? JSON.stringify(body)}`,
  ).toBe(expectedStatus)
  return body
}

async function createCrudFixture(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await apiRequest(request, 'POST', path, { token, data })
  const body = await readJson<{ id?: string; error?: string }>(response)
  expect(response.status(), `${path} create failed: ${body.error ?? JSON.stringify(body)}`).toBe(201)
  expect(typeof body.id === 'string' && body.id.length > 0, `${path} must return id`).toBe(true)
  return body.id!
}

async function postAction(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await apiRequest(request, 'POST', path, { token, data })
  const body = await readJson<Record<string, unknown> & { error?: string }>(response)
  expect(response.status(), `${path} failed: ${body.error ?? JSON.stringify(body)}`).toBe(200)
  return body
}

async function loadStatus(
  request: APIRequestContext,
  token: string,
  intentId: string,
): Promise<RealityStatus> {
  const response = await apiRequest(
    request,
    'GET',
    `/api/reality_layer/status?intentId=${encodeURIComponent(intentId)}`,
    { token },
  )
  expect(response.status(), 'Reality Layer status route must respond').toBe(200)
  return readJson<RealityStatus>(response)
}

async function waitForStatus(
  request: APIRequestContext,
  token: string,
  intentId: string,
  predicate: (status: RealityStatus) => boolean,
  timeoutMs = 20_000,
): Promise<RealityStatus> {
  const deadline = Date.now() + timeoutMs
  let latest: RealityStatus | null = null
  while (Date.now() < deadline) {
    latest = await loadStatus(request, token, intentId)
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for Reality Layer state. Last status: ${JSON.stringify(latest)}`,
  )
}

async function createIntent(
  request: APIRequestContext,
  employeeToken: string,
  options?: {
    sourceKind?: string
    sourceId?: string
    destinationKind?: string
    destinationId?: string
    subjectKind?: string
    subjectId?: string
    parameters?: Record<string, unknown>
    idempotencyKey?: string
  },
) {
  const sourceKind = options?.sourceKind ?? 'cell'
  const sourceId = options?.sourceId ?? 'cell-a'
  const destinationKind = options?.destinationKind ?? 'cell'
  const destinationId = options?.destinationId ?? 'cell-b'
  const body = await postJson<{
    ok: true
    intentId: string
    status: string
    idempotentReplay: boolean
  }>(
    request,
    employeeToken,
    '/api/reality_layer/intents',
    {
      kind: 'move_object',
      subjectKind: options?.subjectKind ?? 'asset',
      subjectId: options?.subjectId ?? `box-${randomUUID().slice(0, 8)}`,
      sourceKind,
      sourceId,
      destinationKind,
      destinationId,
      parameters: options?.parameters ?? {},
      idempotencyKey: options?.idempotencyKey ?? randomUUID(),
    },
    200,
  )
  return { ...body, sourceKind, sourceId, destinationKind, destinationId }
}

async function grantAndAuthorize(
  request: APIRequestContext,
  adminToken: string,
  intentId: string,
  executorId = 'mock:cell-1',
) {
  const grant = await postJson<{ ok: true; grantId: string }>(
    request,
    adminToken,
    '/api/reality_layer/grants',
    {
      intentId,
      executorId,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    200,
  )
  expect(grant.grantId).toBeTruthy()

  const gate = await postJson<{ ok: true; decision: string; status: string }>(
    request,
    adminToken,
    '/api/reality_layer/gate',
    { intentId, executorId },
    200,
  )
  expect(gate.decision).toBe('authorized')
  expect(gate.status).toBe('authorized')
}

async function dispatch(
  request: APIRequestContext,
  adminToken: string,
  intentId: string,
  scenario: 'success' | 'failure' | 'unexpected_result',
  dispatchKey = randomUUID(),
) {
  return postJson<{
    ok: true
    executionId: string
    status: string
    idempotentReplay: boolean
  }>(
    request,
    adminToken,
    '/api/reality_layer/dispatch',
    {
      intentId,
      executorId: 'mock:cell-1',
      dispatchKey,
      mockScenario: scenario,
    },
    202,
  )
}

test.describe('TC-REALITY-001 — Reality Layer MVP causal chain', () => {
  test('BLOCKED → human grant → AUTHORIZED → execution → evidence → proposed diff', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const adminToken = await getAuthToken(request, 'admin')
    const created = await createIntent(request, employeeToken)

    const blockedGate = await postJson<{ ok: true; decision: string; status: string }>(
      request,
      adminToken,
      '/api/reality_layer/gate',
      { intentId: created.intentId, executorId: 'mock:cell-1' },
      200,
    )
    expect(blockedGate.decision).toBe('blocked')
    expect(blockedGate.status).toBe('blocked')

    await grantAndAuthorize(request, adminToken, created.intentId)
    const queued = await dispatch(request, adminToken, created.intentId, 'success')
    expect(queued.executionId).toBeTruthy()

    const terminal = await waitForStatus(
      request,
      adminToken,
      created.intentId,
      (status) =>
        status.executions.some((row) => row.status === 'succeeded') &&
        status.evidence.length > 0 &&
        status.diffs.length > 0,
    )

    expect(terminal.intent.status).toBe('executed')
    expect(terminal.executions).toHaveLength(1)
    expect(terminal.executions[0]?.status).toBe('succeeded')
    expect(terminal.executions[0]?.outcomeCode).toBe('success')
    expect(terminal.evidence).toHaveLength(1)
    expect(terminal.evidence[0]?.claim).toMatchObject({
      location: { kind: created.destinationKind, id: created.destinationId },
      completed: true,
    })
    expect(terminal.diffs).toHaveLength(1)
    expect(terminal.diffs[0]?.status).toBe('proposed')
    expect(terminal.diffs[0]?.effectAdapterKey).toBe('manual_review')

    const moreEvidence = await postJson<{ ok: true; diffId: string; status: string }>(
      request,
      adminToken,
      '/api/reality_layer/reconciliation',
      {
        diffId: terminal.diffs[0]!.id,
        action: 'request_more_evidence',
        reason: 'Integration test deliberately exercises the human-only decision path.',
      },
      200,
    )
    expect(moreEvidence.status).toBe('needs_evidence')
  })

  test('failure produces FAILED execution and no successful physical evidence or diff', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const adminToken = await getAuthToken(request, 'admin')
    const created = await createIntent(request, employeeToken)

    await grantAndAuthorize(request, adminToken, created.intentId)
    await dispatch(request, adminToken, created.intentId, 'failure')

    const terminal = await waitForStatus(
      request,
      adminToken,
      created.intentId,
      (status) => status.executions.some((row) => row.status === 'failed'),
    )

    expect(terminal.intent.status).toBe('failed')
    expect(terminal.executions).toHaveLength(1)
    expect(terminal.executions[0]?.status).toBe('failed')
    expect(terminal.executions[0]?.failureCode).toBe('mock_execution_failed')
    expect(terminal.evidence).toHaveLength(0)
    expect(terminal.diffs).toHaveLength(0)
  })

  test('unexpected_result records actual location and refuses automatic merge', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const adminToken = await getAuthToken(request, 'admin')
    const unexpected = `cell-unexpected-${randomUUID().slice(0, 8)}`
    const created = await createIntent(request, employeeToken, {
      parameters: { mockUnexpectedDestinationId: unexpected },
    })

    await grantAndAuthorize(request, adminToken, created.intentId)
    await dispatch(request, adminToken, created.intentId, 'unexpected_result')

    const terminal = await waitForStatus(
      request,
      adminToken,
      created.intentId,
      (status) =>
        status.executions.some((row) => row.status === 'succeeded') &&
        status.evidence.length > 0 &&
        status.diffs.length > 0,
    )

    expect(terminal.executions[0]?.outcomeCode).toBe('unexpected_result')
    expect(terminal.evidence[0]?.claim).toMatchObject({
      location: { kind: created.destinationKind, id: unexpected },
      completed: true,
    })
    expect(terminal.diffs[0]?.effectAdapterKey).toBe('manual_review')
    expect(terminal.diffs[0]?.proposedChange).toMatchObject({ manualReview: true })

    const mergeAttempt = await apiRequest(
      request,
      'POST',
      '/api/reality_layer/reconciliation',
      {
        token: adminToken,
        data: { diffId: terminal.diffs[0]!.id, action: 'merge' },
      },
    )
    expect(mergeAttempt.status()).toBe(400)
  })

  test('HTTP idempotency keeps one intent and one execution for replayed keys', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const adminToken = await getAuthToken(request, 'admin')
    const intentKey = randomUUID()
    const dispatchKey = randomUUID()

    const subjectId = `box-idem-${randomUUID().slice(0, 8)}`
    const first = await createIntent(request, employeeToken, {
      idempotencyKey: intentKey,
      subjectId,
    })
    const replay = await createIntent(request, employeeToken, {
      idempotencyKey: intentKey,
      subjectId,
    })

    expect(replay.intentId).toBe(first.intentId)
    expect(replay.idempotentReplay).toBe(true)

    await grantAndAuthorize(request, adminToken, first.intentId)
    const firstDispatch = await dispatch(request, adminToken, first.intentId, 'success', dispatchKey)
    const replayDispatch = await dispatch(request, adminToken, first.intentId, 'success', dispatchKey)
    expect(replayDispatch.executionId).toBe(firstDispatch.executionId)

    const terminal = await waitForStatus(
      request,
      adminToken,
      first.intentId,
      (status) => status.executions.some((row) => row.status === 'succeeded'),
    )
    expect(terminal.executions).toHaveLength(1)
  })
})

test.describe('TC-REALITY-002 — WMS reconciliation exactly-once proof', () => {
  test('ERP remains unchanged before merge and one movement exists after merge/retry', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenScope(adminToken)
    const suffix = randomUUID().slice(0, 8)

    let productId: string | null = null
    let warehouseId: string | null = null
    let sourceLocationId: string | null = null
    let destinationLocationId: string | null = null
    let profileId: string | null = null

    try {
      productId = await createProductFixture(request, adminToken, {
        title: `Reality Layer E2E ${suffix}`,
        sku: `RLE2E-${suffix}`,
      })
      const variantId = await createVariantFixture(request, adminToken, {
        productId,
        name: `Reality Layer Variant ${suffix}`,
        sku: `RLE2EV-${suffix}`,
      })

      warehouseId = await createCrudFixture(request, adminToken, '/api/wms/warehouses', {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        name: `Reality Layer Warehouse ${suffix}`,
        code: `RLW${suffix}`,
        city: 'Wroclaw',
        country: 'PL',
        timezone: 'Europe/Warsaw',
        isActive: true,
      })

      sourceLocationId = await createCrudFixture(request, adminToken, '/api/wms/locations', {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouseId,
        code: `SRC-${suffix}`,
        type: 'bin',
        capacityUnits: 100,
        capacityWeight: 500,
        isActive: true,
      })
      destinationLocationId = await createCrudFixture(request, adminToken, '/api/wms/locations', {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouseId,
        code: `DST-${suffix}`,
        type: 'bin',
        capacityUnits: 100,
        capacityWeight: 500,
        isActive: true,
      })

      profileId = await createCrudFixture(request, adminToken, '/api/wms/inventory-profiles', {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        catalogProductId: productId,
        catalogVariantId: variantId,
        defaultUom: 'pcs',
        defaultStrategy: 'fifo',
      })

      await postAction(request, adminToken, '/api/wms/inventory/adjust', {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouseId,
        locationId: sourceLocationId,
        catalogVariantId: variantId,
        delta: 5,
        reason: 'Seed Reality Layer reconciliation fixture',
        referenceType: 'manual',
        referenceId: randomUUID(),
        performedBy: scope.userId,
      })

      const created = await createIntent(request, employeeToken, {
        subjectKind: 'catalog_variant',
        subjectId: variantId,
        sourceKind: 'wms_location',
        sourceId: sourceLocationId,
        destinationKind: 'wms_location',
        destinationId: destinationLocationId,
        parameters: { warehouseId, quantity: 1 },
      })

      await grantAndAuthorize(request, adminToken, created.intentId)
      await dispatch(request, adminToken, created.intentId, 'success')

      const proposed = await waitForStatus(
        request,
        adminToken,
        created.intentId,
        (status) => status.diffs.some((row) => row.status === 'proposed'),
      )
      const diff = proposed.diffs[0]!
      expect(diff.effectAdapterKey).toBe('wms_move')

      const movementUrl =
        `/api/wms/inventory/movements?referenceId=${encodeURIComponent(diff.id)}&page=1&pageSize=20`

      const before = await apiRequest(request, 'GET', movementUrl, { token: adminToken })
      expect(before.status()).toBe(200)
      const beforeBody = await readJson<{ items?: unknown[] }>(before)
      expect(beforeBody.items ?? []).toHaveLength(0)

      const merged = await postJson<{
        ok: true
        diffId: string
        status: string
        movementId: string
      }>(
        request,
        adminToken,
        '/api/reality_layer/reconciliation',
        { diffId: diff.id, action: 'merge' },
        200,
      )
      expect(merged.status).toBe('merged')
      expect(merged.movementId).toBeTruthy()

      const after = await apiRequest(request, 'GET', movementUrl, { token: adminToken })
      expect(after.status()).toBe(200)
      const afterBody = await readJson<{ items?: Array<{ id?: string }> }>(after)
      expect(afterBody.items ?? []).toHaveLength(1)
      expect(afterBody.items?.[0]?.id).toBe(merged.movementId)

      // Exercise the DOWNSTREAM idempotency boundary directly, not only the
      // RealityDiff terminal-state guard. This is the exact WMS effect shape
      // used by reconciliation with the same referenceId = RealityDiff.id.
      // A broken WMS idempotency implementation would move a second unit here.
      const downstreamReplay = await postAction(
        request,
        adminToken,
        '/api/wms/inventory/move',
        {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          warehouseId,
          fromLocationId: sourceLocationId,
          toLocationId: destinationLocationId,
          catalogVariantId: variantId,
          quantity: 1,
          type: 'transfer',
          reason: 'Reality Layer accepted physical reconciliation',
          referenceType: 'manual',
          referenceId: diff.id,
          performedBy: scope.userId,
          metadata: {
            realityIntentId: created.intentId,
            realityDiffId: diff.id,
            replayProbe: true,
          },
        },
      )
      expect(downstreamReplay.movementId).toBe(merged.movementId)

      const afterDownstreamReplay = await apiRequest(
        request,
        'GET',
        movementUrl,
        { token: adminToken },
      )
      expect(afterDownstreamReplay.status()).toBe(200)
      const afterDownstreamReplayBody = await readJson<{ items?: unknown[] }>(
        afterDownstreamReplay,
      )
      expect(afterDownstreamReplayBody.items ?? []).toHaveLength(1)

      const balanceFor = async (locationId: string) => {
        const params = new URLSearchParams({
          warehouseId: warehouseId!,
          locationId,
          catalogVariantId: variantId,
          page: '1',
          pageSize: '20',
        })
        const response = await apiRequest(
          request,
          'GET',
          `/api/wms/inventory/balances?${params.toString()}`,
          { token: adminToken },
        )
        expect(response.status()).toBe(200)
        const body = await readJson<{
          items?: Array<{ quantity_on_hand?: string | number | null }>
        }>(response)
        return Number(body.items?.[0]?.quantity_on_hand ?? 0)
      }

      expect(await balanceFor(sourceLocationId!)).toBe(4)
      expect(await balanceFor(destinationLocationId!)).toBe(1)

      // Also retry the Reality Layer merge endpoint itself. A terminal MERGED
      // diff may return a client error, but it must never append another WMS row.
      const replay = await apiRequest(
        request,
        'POST',
        '/api/reality_layer/reconciliation',
        { token: adminToken, data: { diffId: diff.id, action: 'merge' } },
      )
      expect([200, 400]).toContain(replay.status())

      const afterReplay = await apiRequest(request, 'GET', movementUrl, { token: adminToken })
      expect(afterReplay.status()).toBe(200)
      const afterReplayBody = await readJson<{ items?: unknown[] }>(afterReplay)
      expect(afterReplayBody.items ?? []).toHaveLength(1)

      const closed = await loadStatus(request, adminToken, created.intentId)
      expect(closed.intent.status).toBe('closed')
      expect(closed.diffs[0]?.status).toBe('merged')
    } finally {
      await deleteGeneralEntityIfExists(
        request,
        adminToken,
        '/api/wms/inventory-profiles',
        profileId,
      )
      await deleteGeneralEntityIfExists(
        request,
        adminToken,
        '/api/wms/locations',
        destinationLocationId,
      )
      await deleteGeneralEntityIfExists(
        request,
        adminToken,
        '/api/wms/locations',
        sourceLocationId,
      )
      await deleteGeneralEntityIfExists(
        request,
        adminToken,
        '/api/wms/warehouses',
        warehouseId,
      )
      await deleteCatalogProductIfExists(request, adminToken, productId)
    }
  })
})
