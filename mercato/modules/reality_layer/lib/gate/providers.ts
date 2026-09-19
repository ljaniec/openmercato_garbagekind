import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { AuthorizationGrant } from '../../data/entities'
import { grantScopeDigest } from '../../commands/authorization'
import { gateCheck, type GateCheck, type GateContext } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ExecutorRef =
  | { kind: 'mock'; id: string }
  | { kind: 'robot'; id: string }
  | { kind: 'unsupported'; id: string }

function parseExecutorRef(executorId: string): ExecutorRef {
  if (executorId.startsWith('mock:') && executorId.slice(5).trim()) {
    return { kind: 'mock', id: executorId.slice(5).trim() }
  }
  if (executorId.startsWith('robot:') && executorId.slice(6).trim()) {
    return { kind: 'robot', id: executorId.slice(6).trim() }
  }
  return { kind: 'unsupported', id: executorId }
}

function numberParam(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

function peerUnavailable(name: GateCheck['name'], code: string, reason: string): GateCheck {
  return gateCheck(name, 'unknown', code, reason)
}

function sanitizeProviderFailure(
  name: GateCheck['name'],
  provider: string,
  error: unknown,
): GateCheck {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  const missingRelation = code === '42P01'
  return gateCheck(
    name,
    'unknown',
    missingRelation ? provider + '_unavailable' : provider + '_error',
    missingRelation
      ? provider + ' is not installed or its schema is unavailable.'
      : provider + ' could not produce a trustworthy verdict.',
  )
}

export async function evaluateBusinessPrecondition(
  em: EntityManager,
  context: GateContext,
): Promise<GateCheck> {
  const { intent } = context
  if (!intent.sourceKind || !intent.sourceId) {
    return gateCheck(
      'business_precondition',
      'block',
      'source_missing',
      'A physical move requires an explicit semantic source.',
    )
  }

  if (
    intent.sourceKind === intent.destinationKind &&
    intent.sourceId === intent.destinationId
  ) {
    return gateCheck(
      'business_precondition',
      'block',
      'source_equals_destination',
      'Source and destination identify the same location.',
    )
  }

  const rawQuantity = intent.parametersJson?.quantity
  if (rawQuantity !== undefined) {
    const quantity = numberParam(rawQuantity)
    if (quantity == null || quantity <= 0) {
      return gateCheck(
        'business_precondition',
        'block',
        'quantity_invalid',
        'When quantity is provided it must be a finite positive number.',
      )
    }
  }

  const usesWms =
    intent.sourceKind === 'wms_location' || intent.destinationKind === 'wms_location'

  if (!usesWms) {
    return gateCheck(
      'business_precondition',
      'pass',
      'semantic_preconditions_satisfied',
      'Semantic source, destination and parameters are internally consistent.',
    )
  }

  if (
    intent.sourceKind !== 'wms_location' ||
    intent.destinationKind !== 'wms_location' ||
    intent.subjectKind !== 'catalog_variant'
  ) {
    return gateCheck(
      'business_precondition',
      'block',
      'wms_semantics_incomplete',
      'WMS-backed moves require catalog_variant subject and wms_location source/destination.',
    )
  }

  const quantity = numberParam(rawQuantity)
  if (quantity == null || quantity <= 0) {
    return gateCheck(
      'business_precondition',
      'block',
      'wms_quantity_required',
      'WMS-backed moves require a positive parameters.quantity.',
    )
  }

  if (
    !UUID_RE.test(intent.subjectId) ||
    !UUID_RE.test(intent.sourceId) ||
    !UUID_RE.test(intent.destinationId)
  ) {
    return gateCheck(
      'business_precondition',
      'block',
      'wms_reference_invalid',
      'WMS-backed semantic references must use canonical UUID identifiers.',
    )
  }

  try {
    const locations = await em.getConnection().execute<Array<{ id: string }>>(
      `select id
         from wms_warehouse_locations
        where tenant_id = ?
          and organization_id = ?
          and id in (?, ?)
          and deleted_at is null`,
      [
        intent.tenantId,
        intent.organizationId,
        intent.sourceId,
        intent.destinationId,
      ],
    )
    const ids = new Set((locations ?? []).map((row) => row.id))
    if (!ids.has(intent.sourceId) || !ids.has(intent.destinationId)) {
      return gateCheck(
        'business_precondition',
        'block',
        'wms_location_missing',
        'Source or destination WMS location does not exist in the current scope.',
      )
    }

    const rows = await em.getConnection().execute<Array<{ available: string | number | null }>>(
      `select coalesce(sum(
          coalesce(quantity_on_hand, 0)
          - coalesce(quantity_reserved, 0)
          - coalesce(quantity_allocated, 0)
        ), 0) as available
         from wms_inventory_balances
        where tenant_id = ?
          and organization_id = ?
          and location_id = ?
          and catalog_variant_id = ?
          and deleted_at is null`,
      [intent.tenantId, intent.organizationId, intent.sourceId, intent.subjectId],
    )
    const available = Number(rows?.[0]?.available ?? 0)
    if (!Number.isFinite(available)) {
      return peerUnavailable(
        'business_precondition',
        'wms_balance_invalid',
        'WMS balance could not be interpreted deterministically.',
      )
    }
    if (available < quantity) {
      return gateCheck(
        'business_precondition',
        'block',
        'wms_insufficient_available',
        'Current WMS available quantity is below the requested move quantity.',
        { requested: quantity, available },
      )
    }
    return gateCheck(
      'business_precondition',
      'pass',
      'wms_available',
      'WMS source and destination exist and current available stock covers the request.',
      { requested: quantity, available },
    )
  } catch (error) {
    return sanitizeProviderFailure('business_precondition', 'wms', error)
  }
}

export async function evaluateExecutorCapability(
  em: EntityManager,
  context: GateContext,
): Promise<GateCheck> {
  const ref = parseExecutorRef(context.executorId)
  if (ref.kind === 'unsupported') {
    return gateCheck(
      'executor_capability',
      'block',
      'executor_scheme_unsupported',
      'Executor id must use a supported scheme such as mock:<id> or robot:<uuid>.',
    )
  }
  if (ref.kind === 'mock') {
    return gateCheck(
      'executor_capability',
      'pass',
      'mock_move_object_supported',
      'MockExecutor supports the move_object reference contract.',
      { executorKind: 'mock' },
    )
  }
  if (!UUID_RE.test(ref.id)) {
    return gateCheck(
      'executor_capability',
      'block',
      'robot_id_invalid',
      'robot: executor identifiers must contain a canonical robot UUID.',
    )
  }

  try {
    const rows = await em.getConnection().execute<Array<{
      id: string
      state: string
      cell_id: string | null
      spec: unknown
    }>>(
      `select r.id, r.state, r.cell_id, e.spec
         from fleet_robots r
         join fleet_embodiment_revisions e on e.id = r.embodiment_revision_id
        where r.id = ?
          and r.tenant_id = ?
          and r.organization_id = ?
          and r.deleted_at is null
          and e.deleted_at is null
        limit 1`,
      [ref.id, context.intent.tenantId, context.intent.organizationId],
    )
    if (!rows?.length) {
      return gateCheck(
        'executor_capability',
        'block',
        'robot_missing',
        'The requested robot does not exist in the current Reality Layer scope.',
      )
    }

    const row = rows[0]
    if (!['ready', 'operational'].includes(row.state)) {
      return gateCheck(
        'executor_capability',
        'block',
        'robot_not_available',
        'Robot lifecycle state does not permit a new physical task.',
        { state: row.state },
      )
    }

    const spec = jsonObject(row.spec)
    const kinematics = jsonObject(spec?.kinematics)
    const type = typeof kinematics?.type === 'string' ? kinematics.type : null
    if (!type) {
      return gateCheck(
        'executor_capability',
        'unknown',
        'embodiment_kinematics_unknown',
        'Embodiment contract does not state a kinematics type.',
      )
    }
    if (type !== 'serial_manipulator') {
      return gateCheck(
        'executor_capability',
        'block',
        'executor_not_manipulator',
        'The current move_object MVP requires a serial manipulator executor.',
        { kinematicsType: type },
      )
    }

    const requestedMass = numberParam(context.intent.parametersJson?.massKg)
    if (requestedMass != null && requestedMass > 0) {
      const payload = numberParam(kinematics?.payloadKg)
      if (payload == null) {
        return gateCheck(
          'executor_capability',
          'unknown',
          'payload_unknown',
          'Intent specifies massKg but the embodiment payload limit is unknown.',
          { requestedMassKg: requestedMass },
        )
      }
      if (payload < requestedMass) {
        return gateCheck(
          'executor_capability',
          'block',
          'payload_exceeded',
          'Requested object mass exceeds the embodiment payload limit.',
          { requestedMassKg: requestedMass, payloadKg: payload },
        )
      }
    }

    return gateCheck(
      'executor_capability',
      'pass',
      'robot_capable',
      'Fleet and embodiment facts support the requested move_object operation.',
      { robotId: row.id, state: row.state, cellId: row.cell_id, kinematicsType: type },
    )
  } catch (error) {
    return sanitizeProviderFailure('executor_capability', 'fleet', error)
  }
}

export async function evaluateExecutorCredential(
  em: EntityManager,
  context: GateContext,
): Promise<GateCheck> {
  const ref = parseExecutorRef(context.executorId)
  if (ref.kind === 'unsupported') {
    return gateCheck(
      'executor_credential',
      'block',
      'executor_scheme_unsupported',
      'No credential provider exists for this executor scheme.',
    )
  }
  if (ref.kind === 'mock') {
    return gateCheck(
      'executor_credential',
      'pass',
      'mock_credential_valid',
      'MockExecutor uses the in-process reference credential.',
      { executorKind: 'mock' },
    )
  }
  if (!UUID_RE.test(ref.id)) {
    return gateCheck(
      'executor_credential',
      'block',
      'robot_id_invalid',
      'robot: executor identifiers must contain a canonical robot UUID.',
    )
  }

  try {
    const rows = await em.getConnection().execute<Array<{
      id: string
      status: string
      last_seen_at: string | Date | null
      heartbeat_interval_seconds: number
      liveness_grace_seconds: number
      lost_after_seconds: number
      valid_key: boolean
    }>>(
      `select a.id, a.status, a.last_seen_at, a.heartbeat_interval_seconds,
              a.liveness_grace_seconds, a.lost_after_seconds,
              exists(
                select 1
                  from edge_agent_keys k
                 where k.agent_id = a.id
                   and k.revoked_at is null
                   and k.active_from <= now()
                   and (k.active_until is null or k.active_until > now())
              ) as valid_key
         from edge_agents a
        where a.robot_id = ?
          and a.tenant_id = ?
          and a.organization_id = ?
        order by (a.status = 'enrolled') desc, a.last_seen_at desc nulls last
        limit 1`,
      [ref.id, context.intent.tenantId, context.intent.organizationId],
    )
    if (!rows?.length) {
      return gateCheck(
        'executor_credential',
        'block',
        'edge_agent_missing',
        'No Edge identity is enrolled for the requested robot.',
      )
    }
    const row = rows[0]
    if (row.status !== 'enrolled') {
      return gateCheck(
        'executor_credential',
        'block',
        'edge_agent_revoked',
        'The robot Edge identity is revoked.',
      )
    }
    if (!row.valid_key) {
      return gateCheck(
        'executor_credential',
        'block',
        'edge_key_missing',
        'The enrolled Edge agent has no currently valid signing key.',
      )
    }
    if (!row.last_seen_at) {
      return gateCheck(
        'executor_credential',
        'block',
        'edge_never_seen',
        'The enrolled Edge agent has never established live presence.',
      )
    }

    const lastSeen = new Date(row.last_seen_at)
    const silenceSeconds = Math.max(
      0,
      Math.floor((context.now.getTime() - lastSeen.getTime()) / 1000),
    )
    const deadlineSeconds =
      Math.max(1, Number(row.heartbeat_interval_seconds)) +
      Math.max(0, Number(row.liveness_grace_seconds))
    if (silenceSeconds > deadlineSeconds) {
      return gateCheck(
        'executor_credential',
        'block',
        silenceSeconds >= Math.max(1, Number(row.lost_after_seconds))
          ? 'edge_lost'
          : 'edge_late',
        'A new physical dispatch requires an online Edge identity; the heartbeat is stale.',
        { silenceSeconds, deadlineSeconds },
      )
    }

    return gateCheck(
      'executor_credential',
      'pass',
      'edge_online',
      'Robot identity has a valid key and a heartbeat inside its liveness window.',
      { agentId: row.id, silenceSeconds, deadlineSeconds },
    )
  } catch (error) {
    return sanitizeProviderFailure('executor_credential', 'edge', error)
  }
}

export async function evaluateAuthorizationGrant(
  em: EntityManager,
  context: GateContext,
): Promise<{ check: GateCheck; grantId: string | null }> {
  const grants = await em.find(
    AuthorizationGrant,
    {
      tenantId: context.intent.tenantId,
      organizationId: context.intent.organizationId,
      intentId: context.intent.id,
    } as never,
  )
  const forExecutor = grants.filter((grant) => grant.executorId === context.executorId)
  if (!forExecutor.length) {
    return {
      check: gateCheck(
        'authorization_grant',
        'block',
        'grant_missing',
        'No physical authorization grant exists for this intent and executor.',
      ),
      grantId: null,
    }
  }

  const expectedDigest = grantScopeDigest(context.intent, context.executorId)
  const exact = forExecutor
    .filter((grant) => grant.scopeDigest === expectedDigest)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  if (!exact.length) {
    return {
      check: gateCheck(
        'authorization_grant',
        'block',
        'grant_scope_mismatch',
        'Existing grants do not match the current intent semantics and executor.',
      ),
      grantId: null,
    }
  }

  const active = exact.find(
    (grant) => !grant.revokedAt && grant.expiresAt.getTime() > context.now.getTime(),
  )
  if (active) {
    return {
      check: gateCheck(
        'authorization_grant',
        'pass',
        'grant_valid',
        'A matching non-revoked physical authorization grant is currently valid.',
        { grantId: active.id, expiresAt: active.expiresAt.toISOString() },
      ),
      grantId: active.id,
    }
  }

  const newest = exact[0]
  if (newest.revokedAt) {
    return {
      check: gateCheck(
        'authorization_grant',
        'block',
        'grant_revoked',
        'The matching physical authorization grant has been revoked.',
        { grantId: newest.id },
      ),
      grantId: newest.id,
    }
  }
  return {
    check: gateCheck(
      'authorization_grant',
      'block',
      'grant_expired',
      'The matching physical authorization grant has expired.',
      { grantId: newest.id, expiresAt: newest.expiresAt.toISOString() },
    ),
    grantId: newest.id,
  }
}

export async function evaluateDeterministicPolicy(
  em: EntityManager,
  ctx: CommandRuntimeContext,
  context: GateContext,
): Promise<GateCheck> {
  const ref = parseExecutorRef(context.executorId)
  if (ref.kind === 'unsupported') {
    return gateCheck(
      'deterministic_policy',
      'block',
      'executor_scheme_unsupported',
      'No deterministic policy provider exists for this executor scheme.',
    )
  }
  if (ref.kind === 'mock') {
    return gateCheck(
      'deterministic_policy',
      'pass',
      'mock_policy_cleared',
      'MockExecutor is covered by the deterministic reference policy.',
      { executorKind: 'mock' },
    )
  }
  if (!UUID_RE.test(ref.id)) {
    return gateCheck(
      'deterministic_policy',
      'block',
      'robot_id_invalid',
      'robot: executor identifiers must contain a canonical robot UUID.',
    )
  }

  try {
    const rows = await em.getConnection().execute<Array<{
      state: string
      cell_id: string | null
      cell_class: string | null
      risk_class: string | null
      assignment_id: string | null
      assignment_cell_id: string | null
      policy_version_id: string | null
      desired_state: string | null
    }>>(
      `select r.state, r.cell_id, c.cell_class, c.risk_class,
              a.id as assignment_id, a.cell_id as assignment_cell_id,
              a.policy_version_id, a.desired_state
         from fleet_robots r
         left join fleet_cells c
           on c.id = r.cell_id and c.deleted_at is null
         left join deployment_assignments a
           on a.robot_id = r.id
          and a.tenant_id = r.tenant_id
          and a.superseded_at is null
          and a.revoked_at is null
        where r.id = ?
          and r.tenant_id = ?
          and r.organization_id = ?
          and r.deleted_at is null
        limit 1`,
      [ref.id, context.intent.tenantId, context.intent.organizationId],
    )
    if (!rows?.length) {
      return gateCheck(
        'deterministic_policy',
        'block',
        'robot_missing',
        'The requested robot does not exist in the current scope.',
      )
    }
    const row = rows[0]
    if (row.state !== 'operational') {
      return gateCheck(
        'deterministic_policy',
        'block',
        'robot_not_operational',
        'A real physical dispatch requires the robot lifecycle state operational.',
        { state: row.state },
      )
    }
    if (!row.assignment_id || !row.policy_version_id) {
      return gateCheck(
        'deterministic_policy',
        'block',
        'deployment_assignment_missing',
        'Robot has no active deployment assignment.',
      )
    }
    if (row.desired_state !== 'running') {
      return gateCheck(
        'deterministic_policy',
        'block',
        'deployment_stopped',
        'The active deployment explicitly requires the robot to remain stopped.',
      )
    }
    if (!row.cell_id || !row.cell_class || !row.risk_class) {
      return gateCheck(
        'deterministic_policy',
        'block',
        'cell_context_missing',
        'Robot is not attached to a fully classified physical cell.',
      )
    }
    if (row.assignment_cell_id && row.assignment_cell_id !== row.cell_id) {
      return gateCheck(
        'deterministic_policy',
        'block',
        'deployment_cell_stale',
        'Deployment assignment was issued for a different cell than the robot currently occupies.',
      )
    }

    try {
      const bus = ctx.container.resolve('commandBus') as CommandBus
      const response = await bus.execute('safety.clearance.check', {
        input: {
          organizationId: context.intent.organizationId,
          tenantId: context.intent.tenantId,
          policyVersionId: row.policy_version_id,
          cellClass: row.cell_class,
          riskClass: row.risk_class,
        },
        ctx,
      })
      const result = response.result as { cleared?: boolean; reasons?: string[] }
      if (!result?.cleared) {
        return gateCheck(
          'deterministic_policy',
          'block',
          'safety_clearance_denied',
          'Current Safety clearance does not permit this deployment in the current cell class.',
          {
            assignmentId: row.assignment_id,
            policyVersionId: row.policy_version_id,
            reasons: Array.isArray(result?.reasons) ? result.reasons.slice(0, 10) : [],
          },
        )
      }
      return gateCheck(
        'deterministic_policy',
        'pass',
        'deployment_and_safety_cleared',
        'Active deployment is running and current Safety clearance passes.',
        {
          assignmentId: row.assignment_id,
          policyVersionId: row.policy_version_id,
          cellClass: row.cell_class,
          riskClass: row.risk_class,
        },
      )
    } catch {
      return peerUnavailable(
        'deterministic_policy',
        'safety_unavailable',
        'Safety clearance command is unavailable; the gate fails closed.',
      )
    }
  } catch (error) {
    return sanitizeProviderFailure('deterministic_policy', 'physical_ai_policy', error)
  }
}
