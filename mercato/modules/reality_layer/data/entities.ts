import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type PhysicalIntentKind = 'move_object'

export type PhysicalIntentStatus =
  | 'pending'
  | 'blocked'
  | 'authorized'
  | 'dispatched'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'closed'

export type IntentOriginatorKind = 'human' | 'agent' | 'service' | 'ai_tool'

export type ExecutionStatus =
  | 'queued'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'abandoned'

export type RealityDiffStatus =
  | 'proposed'
  | 'needs_evidence'
  | 'rejected'
  | 'merging'
  | 'merge_failed'
  | 'merged'

@Entity({ tableName: 'reality_layer_intents' })
@Index({
  name: 'reality_layer_intents_scope_status_idx',
  properties: ['tenantId', 'organizationId', 'status', 'createdAt'],
})
@Index({ name: 'reality_layer_intents_originator_idx', properties: ['originatorUserId'] })
@Unique({
  name: 'reality_layer_intents_idempotency_unique',
  properties: ['tenantId', 'organizationId', 'idempotencyKey'],
})
export class PhysicalIntent {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  kind: PhysicalIntentKind = 'move_object'

  @Property({ name: 'subject_kind', type: 'text' })
  subjectKind!: string

  @Property({ name: 'subject_id', type: 'text' })
  subjectId!: string

  @Property({ name: 'source_kind', type: 'text', nullable: true })
  sourceKind?: string | null

  @Property({ name: 'source_id', type: 'text', nullable: true })
  sourceId?: string | null

  @Property({ name: 'destination_kind', type: 'text' })
  destinationKind!: string

  @Property({ name: 'destination_id', type: 'text' })
  destinationId!: string

  @Property({ name: 'context_kind', type: 'text', nullable: true })
  contextKind?: string | null

  @Property({ name: 'context_id', type: 'text', nullable: true })
  contextId?: string | null

  @Property({ name: 'parameters_json', type: 'json' })
  parametersJson: Record<string, unknown> = {}

  @Property({ type: 'text', default: 'pending' })
  status: PhysicalIntentStatus = 'pending'

  @Property({ name: 'originator_user_id', type: 'uuid', nullable: true })
  originatorUserId?: string | null

  @Property({ name: 'originator_kind', type: 'text' })
  originatorKind!: IntentOriginatorKind

  @Property({ name: 'origin_context_json', type: 'json', nullable: true })
  originContextJson?: Record<string, unknown> | null

  @Property({ name: 'selected_executor_id', type: 'text', nullable: true })
  selectedExecutorId?: string | null

  @Property({ name: 'latest_gate_json', type: 'json', nullable: true })
  latestGateJson?: Record<string, unknown> | null

  @Property({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'reality_layer_authorization_grants' })
@Index({
  name: 'reality_layer_grants_intent_expiry_idx',
  properties: ['tenantId', 'organizationId', 'intentId', 'expiresAt'],
})
@Unique({
  name: 'reality_layer_grants_idempotency_unique',
  properties: ['tenantId', 'organizationId', 'idempotencyKey'],
})
export class AuthorizationGrant {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'intent_id', type: 'uuid' })
  intentId!: string

  @Property({ name: 'executor_id', type: 'text' })
  executorId!: string

  @Property({ name: 'action_kind', type: 'text' })
  actionKind!: string

  @Property({ name: 'destination_kind', type: 'text' })
  destinationKind!: string

  @Property({ name: 'destination_id', type: 'text' })
  destinationId!: string

  @Property({ name: 'granted_by_user_id', type: 'uuid' })
  grantedByUserId!: string

  @Property({ name: 'scope_digest', type: 'text' })
  scopeDigest!: string

  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  @Property({ name: 'revoked_at', type: Date, nullable: true })
  revokedAt?: Date | null

  @Property({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'reality_layer_execution_records' })
@Index({
  name: 'reality_layer_executions_intent_idx',
  properties: ['tenantId', 'organizationId', 'intentId', 'createdAt'],
})
@Unique({
  name: 'reality_layer_executions_attempt_unique',
  properties: ['tenantId', 'organizationId', 'intentId', 'attemptNo'],
})
@Unique({
  name: 'reality_layer_executions_dispatch_unique',
  properties: ['tenantId', 'organizationId', 'dispatchKey'],
})
export class ExecutionRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'intent_id', type: 'uuid' })
  intentId!: string

  @Property({ name: 'executor_id', type: 'text' })
  executorId!: string

  @Property({ name: 'attempt_no', type: 'int' })
  attemptNo!: number

  @Property({ name: 'dispatch_key', type: 'uuid' })
  dispatchKey!: string

  @Property({ type: 'text', default: 'queued' })
  status: ExecutionStatus = 'queued'

  @Property({ name: 'external_execution_id', type: 'text', nullable: true })
  externalExecutionId?: string | null

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'outcome_code', type: 'text', nullable: true })
  outcomeCode?: string | null

  @Property({ name: 'failure_code', type: 'text', nullable: true })
  failureCode?: string | null

  @Property({ name: 'executor_metadata_json', type: 'json', nullable: true })
  executorMetadataJson?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'reality_layer_evidence' })
@Index({
  name: 'reality_layer_evidence_intent_idx',
  properties: ['tenantId', 'organizationId', 'intentId', 'recordedAt'],
})
@Unique({
  name: 'reality_layer_evidence_source_event_unique',
  properties: ['tenantId', 'organizationId', 'sourceKind', 'sourceId', 'externalEventId'],
})
export class EvidenceEnvelope {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'intent_id', type: 'uuid' })
  intentId!: string

  @Property({ name: 'execution_id', type: 'uuid', nullable: true })
  executionId?: string | null

  @Property({ name: 'source_kind', type: 'text' })
  sourceKind!: string

  @Property({ name: 'source_id', type: 'text' })
  sourceId!: string

  @Property({ name: 'evidence_type', type: 'text' })
  evidenceType!: string

  @Property({ name: 'claim_json', type: 'json' })
  claimJson!: Record<string, unknown>

  @Property({ type: 'double', nullable: true })
  confidence?: number | null

  @Property({ name: 'observed_at', type: Date })
  observedAt!: Date

  @Property({ name: 'recorded_at', type: Date, onCreate: () => new Date() })
  recordedAt: Date = new Date()

  @Property({ name: 'artifact_refs', type: 'json', nullable: true })
  artifactRefs?: string[] | null

  @Property({ name: 'provenance_json', type: 'json', nullable: true })
  provenanceJson?: Record<string, unknown> | null

  @Property({ name: 'external_event_id', type: 'text' })
  externalEventId!: string

  @Property({ name: 'late_event', type: 'boolean', default: false })
  lateEvent: boolean = false
}

@Entity({ tableName: 'reality_layer_diffs' })
@Index({
  name: 'reality_layer_diffs_scope_status_idx',
  properties: ['tenantId', 'organizationId', 'status', 'createdAt'],
})
@Index({
  name: 'reality_layer_diffs_intent_idx',
  properties: ['tenantId', 'organizationId', 'intentId', 'createdAt'],
})
@Unique({
  name: 'reality_layer_diffs_execution_unique',
  properties: ['tenantId', 'organizationId', 'executionId'],
})
export class RealityDiff {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'intent_id', type: 'uuid' })
  intentId!: string

  @Property({ name: 'execution_id', type: 'uuid' })
  executionId!: string

  @Property({ type: 'text', default: 'proposed' })
  status: RealityDiffStatus = 'proposed'

  @Property({ name: 'business_before_json', type: 'json' })
  businessBeforeJson!: Record<string, unknown>

  @Property({ name: 'business_version_digest', type: 'text' })
  businessVersionDigest!: string

  @Property({ name: 'observed_json', type: 'json' })
  observedJson!: Record<string, unknown>

  @Property({ name: 'proposed_change_json', type: 'json' })
  proposedChangeJson!: Record<string, unknown>

  @Property({ name: 'evidence_ids', type: 'json' })
  evidenceIds: string[] = []

  @Property({ name: 'effect_adapter_key', type: 'text' })
  effectAdapterKey!: string

  @Property({ name: 'effect_command_id', type: 'text' })
  effectCommandId!: string

  @Property({ name: 'effect_input_json', type: 'json' })
  effectInputJson!: Record<string, unknown>

  @Property({ name: 'decision_actor_user_id', type: 'uuid', nullable: true })
  decisionActorUserId?: string | null

  @Property({ name: 'decided_at', type: Date, nullable: true })
  decidedAt?: Date | null

  @Property({ name: 'merge_result_json', type: 'json', nullable: true })
  mergeResultJson?: Record<string, unknown> | null

  @Property({ name: 'failure_code', type: 'text', nullable: true })
  failureCode?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
