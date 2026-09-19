import { Migration } from '@mikro-orm/migrations'

export class Migration20260919235500_reality_layer extends Migration {
  override name = 'Migration20260919235500_reality_layer'

  override up(): void | Promise<void> {
    this.addSql(`create table "reality_layer_intents" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "kind" text not null,
      "subject_kind" text not null,
      "subject_id" text not null,
      "source_kind" text null,
      "source_id" text null,
      "destination_kind" text not null,
      "destination_id" text not null,
      "context_kind" text null,
      "context_id" text null,
      "parameters_json" jsonb not null,
      "status" text not null default 'pending',
      "originator_user_id" uuid null,
      "originator_kind" text not null,
      "origin_context_json" jsonb null,
      "selected_executor_id" text null,
      "latest_gate_json" jsonb null,
      "idempotency_key" uuid not null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "reality_layer_intents_scope_status_idx"
      on "reality_layer_intents" ("tenant_id", "organization_id", "status", "created_at");`)
    this.addSql(`create index "reality_layer_intents_originator_idx"
      on "reality_layer_intents" ("originator_user_id");`)
    this.addSql(`alter table "reality_layer_intents"
      add constraint "reality_layer_intents_idempotency_unique"
      unique ("tenant_id", "organization_id", "idempotency_key");`)

    this.addSql(`create table "reality_layer_authorization_grants" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "intent_id" uuid not null,
      "executor_id" text not null,
      "action_kind" text not null,
      "destination_kind" text not null,
      "destination_id" text not null,
      "granted_by_user_id" uuid not null,
      "scope_digest" text not null,
      "expires_at" timestamptz not null,
      "revoked_at" timestamptz null,
      "idempotency_key" uuid not null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "reality_layer_grants_intent_expiry_idx"
      on "reality_layer_authorization_grants"
      ("tenant_id", "organization_id", "intent_id", "expires_at");`)
    this.addSql(`alter table "reality_layer_authorization_grants"
      add constraint "reality_layer_grants_idempotency_unique"
      unique ("tenant_id", "organization_id", "idempotency_key");`)

    this.addSql(`create table "reality_layer_execution_records" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "intent_id" uuid not null,
      "executor_id" text not null,
      "attempt_no" int not null,
      "dispatch_key" uuid not null,
      "status" text not null default 'queued',
      "external_execution_id" text null,
      "started_at" timestamptz null,
      "finished_at" timestamptz null,
      "outcome_code" text null,
      "failure_code" text null,
      "executor_metadata_json" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "reality_layer_executions_intent_idx"
      on "reality_layer_execution_records"
      ("tenant_id", "organization_id", "intent_id", "created_at");`)
    this.addSql(`alter table "reality_layer_execution_records"
      add constraint "reality_layer_executions_attempt_unique"
      unique ("tenant_id", "organization_id", "intent_id", "attempt_no");`)
    this.addSql(`alter table "reality_layer_execution_records"
      add constraint "reality_layer_executions_dispatch_unique"
      unique ("tenant_id", "organization_id", "dispatch_key");`)

    this.addSql(`create table "reality_layer_evidence" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "intent_id" uuid not null,
      "execution_id" uuid null,
      "source_kind" text not null,
      "source_id" text not null,
      "evidence_type" text not null,
      "claim_json" jsonb not null,
      "confidence" double precision null,
      "observed_at" timestamptz not null,
      "recorded_at" timestamptz not null,
      "artifact_refs" jsonb null,
      "provenance_json" jsonb null,
      "external_event_id" text not null,
      "late_event" boolean not null default false,
      primary key ("id"));`)
    this.addSql(`create index "reality_layer_evidence_intent_idx"
      on "reality_layer_evidence"
      ("tenant_id", "organization_id", "intent_id", "recorded_at");`)
    this.addSql(`alter table "reality_layer_evidence"
      add constraint "reality_layer_evidence_source_event_unique"
      unique ("tenant_id", "organization_id", "source_kind", "source_id", "external_event_id");`)

    this.addSql(`create table "reality_layer_diffs" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "intent_id" uuid not null,
      "execution_id" uuid not null,
      "status" text not null default 'proposed',
      "business_before_json" jsonb not null,
      "business_version_digest" text not null,
      "observed_json" jsonb not null,
      "proposed_change_json" jsonb not null,
      "evidence_ids" jsonb not null,
      "effect_adapter_key" text not null,
      "effect_command_id" text not null,
      "effect_input_json" jsonb not null,
      "decision_actor_user_id" uuid null,
      "decided_at" timestamptz null,
      "merge_result_json" jsonb null,
      "failure_code" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "reality_layer_diffs_scope_status_idx"
      on "reality_layer_diffs" ("tenant_id", "organization_id", "status", "created_at");`)
    this.addSql(`create index "reality_layer_diffs_intent_idx"
      on "reality_layer_diffs" ("tenant_id", "organization_id", "intent_id", "created_at");`)
    this.addSql(`alter table "reality_layer_diffs"
      add constraint "reality_layer_diffs_execution_unique"
      unique ("tenant_id", "organization_id", "execution_id");`)

    this.addSql(`alter table "reality_layer_authorization_grants"
      add constraint "reality_layer_grants_intent_foreign"
      foreign key ("intent_id") references "reality_layer_intents" ("id");`)
    this.addSql(`alter table "reality_layer_execution_records"
      add constraint "reality_layer_executions_intent_foreign"
      foreign key ("intent_id") references "reality_layer_intents" ("id");`)
    this.addSql(`alter table "reality_layer_evidence"
      add constraint "reality_layer_evidence_intent_foreign"
      foreign key ("intent_id") references "reality_layer_intents" ("id");`)
    this.addSql(`alter table "reality_layer_evidence"
      add constraint "reality_layer_evidence_execution_foreign"
      foreign key ("execution_id") references "reality_layer_execution_records" ("id");`)
    this.addSql(`alter table "reality_layer_diffs"
      add constraint "reality_layer_diffs_intent_foreign"
      foreign key ("intent_id") references "reality_layer_intents" ("id");`)
    this.addSql(`alter table "reality_layer_diffs"
      add constraint "reality_layer_diffs_execution_foreign"
      foreign key ("execution_id") references "reality_layer_execution_records" ("id");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "reality_layer_diffs" cascade;`)
    this.addSql(`drop table if exists "reality_layer_evidence" cascade;`)
    this.addSql(`drop table if exists "reality_layer_execution_records" cascade;`)
    this.addSql(`drop table if exists "reality_layer_authorization_grants" cascade;`)
    this.addSql(`drop table if exists "reality_layer_intents" cascade;`)
  }
}
