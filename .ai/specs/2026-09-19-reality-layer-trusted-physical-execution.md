# Reality Layer: Trusted Physical Execution for Agentic ERP

**Status:** Draft architecture blueprint — implementation intentionally blocked pending human review  
**Date:** 2026-09-19  
**Target repository branch:** `physical_ai` → implementation branch `reality-layer-physical-ai`  
**Physical AI fork baseline:** `ljaniec/openmercato_garbagekind@physical_ai` = `4aab8095564309f61b5354e45a180d7b27ac37e0`  
**Open Mercato baseline inspected:** `open-mercato/open-mercato@ab23d45ffc3aeca5e7d994eb57d5526c5b0a4712`

## TLDR

Reality Layer is a self-contained Open Mercato application module that creates a trusted boundary between business/AI intent and physical execution.

Its three non-negotiable separations are:

> **Intent is not authorization. Execution is not evidence. Evidence is not truth.**

The MVP accepts a typed semantic `PhysicalIntent`, evaluates deterministic Reality Gate checks, requires a narrowly scoped human grant when policy is missing, dispatches an authorized task asynchronously to a replaceable executor, records append-only evidence, computes a `RealityDiff`, and changes authoritative Open Mercato state **only after an explicit reconciliation decision**. The physical backend is replaceable: `MockExecutor` is the reference executor; A1XY and LeRobot are adapters.

The module does **not** expose joint commands, trajectories, `/cmd_vel`, MoveIt, Nav2, VLM internals, fleet scheduling, or robot kinematics. It operates at the semantic ERP ↔ physical-world boundary.

The HackOn vertical slice is:

1. create `PhysicalIntent(move_object)`;
2. Reality Gate blocks it on one deterministic missing authorization;
3. an authorized human creates a scoped, expiring grant;
4. the gate passes;
5. `MockExecutor` runs through an Open Mercato queue worker;
6. execution produces evidence;
7. Reality Layer computes a diff;
8. the business/WMS state remains unchanged;
9. an authorized reconciliation accepts the diff;
10. the module invokes the existing domain command through `CommandBus`;
11. the Open Mercato `ActionLog` and Reality Layer provenance chain show who/what caused the change.

This is one independently deployable capability. Agent Orchestrator, AI Assistant, `fleet`, `edge`, `safety`, `vision`, A1XY, LeRobot, and VLM integration are optional peers/adapters; the MVP must run with only core Open Mercato + the Reality Layer + `MockExecutor`.

## Architecture decision

### Placement

Source-of-truth in this repository:

```text
mercato/modules/reality_layer/
```

installed by the existing `mercato/install.sh` into:

```text
apps/mercato/src/modules/reality_layer/
```

This follows the existing app-module approach used by `fleet`, `safety`, `vision`, `edge`, and `work_orders`. No Open Mercato core patch is required for the MVP.

### Primary boundary

```text
Business / human / AI / workflow
             |
             | semantic request
             v
       PhysicalIntent
             |
             v
        Reality Gate
       /      |      \
 actor auth  policy  executor capability/credential
             |
             v
 AuthorizedPhysicalIntent (value object; not a new authority source)
             |
             v
     execution queue worker
             |
             v
       PhysicalExecutor
             |
             v
      ExecutionRecord
             |
             v
    EvidenceEnvelope(s)
             |
             v
        RealityDiff
             |
       +-----+------+
       |            |
    reject      accept/merge
                    |
                    v
           existing domain Command
                    |
                    v
            authoritative ERP state
```

### Core architectural choices frozen for the MVP

1. **Physical authorization is a Reality Layer concept.** Human RBAC determines who may request/approve/reconcile; executor credentials prove what a machine is permitted to do. They are separate.
2. **Reality Layer is a boundary module, not a robot-control module.** This preserves the `physical_ai` rule that robot control-plane modules do not depend on WMS/catalog/sales. The core Reality Layer has no hard dependency on those modules; ERP reconciliation is reached through effect adapters and the CommandBus.
3. **AI pending actions are not physical grants.** `prepareMutation` remains the AI-framework gate for AI-initiated database writes such as creating an intent. It does not authorize a robot to act.
4. **Agent Orchestrator is an optional intent origin.** An approved Agent Orchestrator effector may create a PhysicalIntent through the command bus. It must not synchronously command hardware.
5. **Physical dispatch is asynchronous.** An Open Mercato queue worker owns execution attempts. HTTP/API handlers never wait for a robot operation.
6. **Evidence is append-only.** Executor/VLM/camera/barcode/human observations are claims with provenance, not business truth.
7. **RealityDiff is a separate abstraction from `work_orders.Reconciliation`.** The existing work-orders reconciliation compares robot piece claims with scale mass and may directly receive inventory; it has different semantics.
8. **The business mutation happens last.** Reconciliation acceptance invokes an existing command such as `wms.inventory.move`; no cross-module table write is allowed.
9. **MockExecutor is normative.** It is the reference implementation and contract test target, not disposable demo code.
10. **Fail closed.** Unknown capability, missing credential status, incomplete policy result, expired grant, stale business precondition, or ambiguous evidence blocks advancement.
11. **Idempotency is end-to-end.** Intent submission, dispatch, executor callback/evidence ingestion, diff creation, and reconciliation merge each have their own stable idempotency boundary.

## Repository-grounded constraints

The design is based on the following current implementation surfaces, not on hypothetical APIs:

| Concern | Current source | Consequence for Reality Layer |
|---|---|---|
| Module conventions | `open-mercato/.ai/docs/module-development.md`; current `apps/mercato/src/modules/example` | App module with `acl.ts`, `setup.ts`, `di.ts`, `events.ts`, commands, routes, workers, backend pages |
| API | `apps/mercato/src/modules/example/api/todos/route.ts` | Route files export per-method `metadata` and `openApi`; CRUD uses `makeCrudRoute`, custom writes use mutation guards |
| Commands/audit | `packages/shared/src/lib/commands/{types,command-bus}.ts` | All domain mutations through `CommandBus`; ActionLog is canonical audit trail |
| Workers | `packages/queue/AGENTS.md`; runtime workers docs | Executor dispatch is a retryable idempotent worker; no custom polling/job queue |
| Events | `packages/events/AGENTS.md`; `createModuleEvents` | Typed events in `events.ts`; persistent subscribers must be idempotent |
| Workflows | `packages/core/src/modules/workflows/AGENTS.md` | USER_TASK / WAIT_FOR_SIGNAL are available for optional orchestration; workflow lifecycle stays owned by workflows |
| AI mutation approval | `packages/ai-assistant/.../prepare-mutation.ts`, `pending-action-types.ts` | AI DB writes get explicit confirmation, stale-version checking, TTL and dedupe; not reused as physical credentialing |
| Agent Orchestrator | `packages/enterprise/src/modules/agent_orchestrator/AGENTS.md` | Propose-only: proposal → disposition → effector → command; optional enterprise integration only |
| WMS effect | `packages/core/src/modules/wms/commands/inventory-actions.ts` | `wms.inventory.move` is an existing auditable business mutation for the move-object demo |
| Existing fleet | `mercato/modules/fleet/*` | Robot/cell/embodiment/calibration are useful optional evidence/gate inputs, but an executor is broader than a robot row |
| Existing edge | `mercato/modules/edge/*` | Machine identity/liveness is a useful optional credential provider and must remain distinct from human RBAC |
| Existing safety | `mercato/modules/safety/*` | Deterministic policy/deployment clearance may feed the gate, but is not per-intent authorization |
| Existing vision | `mercato/modules/vision/*` | Camera/detector artifacts can become evidence sources; vision entities are not the generic evidence ledger |
| Existing work orders | `mercato/modules/work_orders/*` | Keep weight-vs-robot accounting reconciliation distinct from RealityDiff reconciliation |

## Scope / non-goals

MVP includes only semantic move-object intent, deterministic gate checks, scoped human grant, MockExecutor, execution record, evidence, RealityDiff, manual accept/reject/request-more-evidence, one WMS-backed business effector, provenance, and critical tests.

MVP explicitly excludes: trajectory planning, ROS graph modeling, MoveIt/Nav2/OpenRMF, digital twin, Gazebo/Isaac Sim, generic robotics ontology, fleet optimization, VLM training, policy learning, multi-robot planning, blockchain, and a full vendor-neutral protocol.

## A. Executive summary

Reality Layer adds one capability to Open Mercato: trustworthy lifecycle management for semantic operations whose effects occur outside the database. The module deliberately does not become a robot controller. It records what business outcome was requested, whether that request is authorized for a particular executor, what execution attempt occurred, what independent observations claim happened, and what business-state change is proposed as a result.

The key safety boundary is a two-stage commit in the semantic—not database—sense:

1. **authorize and execute a physical task**;
2. **independently reconcile observed reality into business truth**.

The first stage may change the physical world and cannot be rolled back transactionally. The second stage is an ordinary Open Mercato domain mutation and therefore uses the existing command/audit mechanism. A successful physical execution can exist indefinitely without an ERP mutation; a failed execution can still produce evidence and a proposed diff if something physically changed.

For HackOn, the business effect adapter is the existing WMS command \`wms.inventory.move\`. The source branch already contains \`fleet\`, \`edge\`, \`safety\`, \`vision\`, and \`work_orders\` concepts that can enrich future gate/evidence adapters, but Reality Layer does not depend on them for its core semantics.

## B. Repository findings

### B.1 Open Mercato framework findings

| Component | Concrete source | Current behavior | Decision |
|---|---|---|---|
| Module discovery | \`.ai/docs/module-development.md\`, \`packages/cli/src/lib/generators/module-registry.ts\` | Discovers module convention files and app-local modules | **Reuse** |
| API convention | \`apps/mercato/src/modules/example/api/todos/route.ts\` | \`route.ts\` files export per-method \`metadata\` and \`openApi\`; CRUD factory owns normal CRUD | **Reuse exactly** |
| Custom writes | \`packages/core/AGENTS.md\`, \`@open-mercato/shared/lib/crud/route-mutation-guard\` | Non-CRUD action routes run mutation guards before writes | **Reuse exactly** |
| Command registry/bus | \`packages/shared/src/lib/commands/{registry,types,command-bus}.ts\` | Registered commands execute under scoped context and persist \`ActionLog\` metadata/snapshots | **Reuse exactly** |
| Audit | \`packages/core/src/modules/audit_logs/data/entities.ts\` | \`ActionLog\` records actor, on-behalf-of actor, resource links, command payload/snapshots/context | **Reuse; do not invent a parallel audit log** |
| Events | \`packages/events/AGENTS.md\`, \`createModuleEvents()\` | Typed module events; persistent delivery is at-least-once | **Reuse; subscribers idempotent** |
| Queue/workers | \`packages/queue/AGENTS.md\`, \`apps/docs/docs/framework/runtime/workers.mdx\` | Retriable background jobs, auto-discovered workers, abandoned-job callback | **Use for physical dispatch** |
| Module runtime | \`.ai/specs/SPEC-072-2026-09-11-module-runtime-start-hook.md\` | Process-wide long-lived runtime | **Avoid for per-intent execution** |
| Workflows | \`packages/core/src/modules/workflows/AGENTS.md\` | USER_TASK, WAIT_FOR_SIGNAL, command-backed activities | **Optional orchestration only** |
| AI pending actions | \`packages/ai-assistant/src/modules/ai_assistant/lib/prepare-mutation.ts\`, \`pending-action-types.ts\` | AI write calls become TTL-scoped pending mutations with diff/idempotency/stale recheck | **Reuse for AI-created intents; not physical grants** |
| Agent Orchestrator | \`packages/enterprise/src/modules/agent_orchestrator/AGENTS.md\` | Agent is propose-only; disposition then effector then command; agent identity is audited | **Optional origin only** |
| Agent identity | \`packages/core/src/modules/auth/data/entities.ts\`, \`packages/shared/src/lib/commands/types.ts\` | \`User.kind\` distinguishes human/agent/service; \`runAs\` carries agent→human attribution | **Reuse for no-self-authorization checks** |
| WMS transfer | \`packages/core/src/modules/wms/commands/inventory-actions.ts\` | \`wms.inventory.move\` is audited, non-generic-undo, and idempotent by movement reference + facts | **Reuse for MVP business effect** |
| UI | \`packages/ui/AGENTS.md\` | DataTable, apiCall, useGuardedMutation, shared status/audit primitives | **Reuse; no bespoke UI framework** |
| Integration tests | \`.ai/qa/AGENTS.md\` | Module-local Playwright integration tests; shared auth/API helpers | **Reuse** |

### B.2 Findings in this repository's \`physical_ai\` branch

| Component | Concrete source | What it currently represents | Reality Layer treatment |
|---|---|---|---|
| Physical-AI framing | \`physical-ai/README.md\` | Business/control-plane framing around robot deployments and auditability | **Align** |
| Robot/cell registry | \`mercato/modules/fleet/data/entities.ts\`, \`lib/embodimentSpec.ts\` | Robot, cell, embodiment/calibration facts | **Optional gate adapter**; never define executor = robot |
| Edge identity/liveness | \`mercato/modules/edge/data/entities.ts\`, \`lib/liveness.ts\`, \`api/connect/route.ts\` | Machine/edge-agent identity and liveness | **Optional executor-credential provider** |
| Deterministic safety | \`mercato/modules/safety/lib/clearance.ts\`, \`data/entities.ts\` | Deployment/safety-case clearance | **Optional policy input**, not per-intent approval |
| Vision | \`mercato/modules/vision/data/entities.ts\`, \`lib/lawful.ts\`, \`lib/triangulate.ts\` | Camera/detector/detection artifacts | **Potential evidence source**, not generic evidence storage |
| Work order accounting | \`mercato/modules/work_orders/lib/reconcile.ts\`, \`commands/workOrders.ts\` | Compares robot piece claims with scale mass; batch close may directly receive inventory | **Keep separate** from RealityDiff |
| Installer | \`mercato/install.sh\` | Copies custom modules to \`apps/mercato/src/modules\`, updates enabled modules, runs generation | **Add \`reality_layer\` to same path** |
| Existing custom APIs | e.g. \`mercato/modules/fleet/api/robots/route.ts\` | Hackathon action/list APIs | **Do not copy blindly**: new routes must include current \`openApi\` exports and mutation guards |

### B.3 Specific incompatibilities/debt found

1. The hackathon branch does not contain Open Mercato framework sources/docs, so framework APIs must be pinned to the inspected upstream SHA above.
2. Several existing custom physical-AI routes predate/currently omit the complete OpenAPI surface expected by the current Open Mercato example. Reality Layer routes must export \`openApi\`; no directory-layout migration is required.
3. The existing \`work_orders.Reconciliation\` is a domain-specific mass/piece accounting record, not a general observation-to-business-state diff. Reusing it would create semantic coupling and unsafe automatic writes.
4. Existing safety clearance is about deployment/safety-case status, not a narrowly scoped authority for a particular physical operation. It cannot substitute for an \`AuthorizationGrant\`.
5. Existing edge credentials are machine credentials. They must not be converted into human role grants, and human RBAC must not be treated as proof that a machine is authenticated.

## C. Architectural decision

### C.1 Module ownership

\`reality_layer\` owns:

- semantic physical intent lifecycle;
- deterministic gate evaluation;
- narrowly scoped physical authorization grants;
- executor abstraction/registry;
- execution-attempt ledger;
- evidence envelopes;
- RealityDiff lifecycle;
- reconciliation orchestration and provenance.

It does **not** own:

- WMS inventory truth;
- work-order truth;
- robot registry truth;
- machine credentials outside its adapter contract;
- safety case truth;
- camera/VLM models;
- trajectories/controllers.

Cross-module business effects are invoked through registered commands. Optional module facts are consumed through adapters/services or events, never direct ORM relationships.

### C.2 Why physical execution is not an Agent Orchestrator effector

An Agent Orchestrator effector is the boundary that converts an approved agent proposal into an Open Mercato command. Physical execution has additional semantics: delayed start, independent machine credential state, external side effects, retries, disconnection, late completion and evidence. Therefore:

\`\`\`text
agent proposal
  -> disposition
  -> AO effector
  -> reality_layer.intent.create command
  -> Reality Gate / human grant / queue
  -> physical executor
\`\`\`

The AO effector stops at intent creation. It never invokes \`PhysicalExecutor.execute()\`.

### C.3 Why a queue worker is the execution boundary

The Open Mercato queue contract already supplies:

- asynchronous execution;
- retry delivery;
- explicit requirement for idempotent handlers;
- local strategy for development/demo;
- BullMQ strategy for production;
- \`onJobAbandoned\` for failures that occur before handler entry.

This matches physical dispatch better than an HTTP request, workflow activity held open for minutes, or \`runtime.ts\`. The authoritative execution attempt exists in the database before enqueue; a queue job references it by ID.

### C.4 Why RealityDiff is separate from AI mutation previews

\`AiPendingAction.fieldDiff\` is a preview of a proposed **database mutation** before that mutation occurs. \`RealityDiff\` is a durable claim about a discrepancy between authoritative business state and observed physical state **after an external operation or observation**. They have opposite temporal semantics. They may look similar in UI but cannot share the same persistence model.

### C.5 Why there is no generic rollback

Physical execution cannot be transactionally undone. Existing WMS inventory commands follow the same principle: movement commands are non-generic-undo and reversal is a new audited counter-action. Reality Layer therefore records compensation as a future semantic request, never a database rollback of the physical action.

## D. Domain model

The MVP persists **five entities**. Candidate concepts that do not need durable identity remain value objects/services.

### D.1 \`PhysicalIntent\` — persistent entity

Purpose: immutable semantic request fields plus controlled lifecycle/provenance.

Key fields:

| Field | Shape / rule |
|---|---|
| \`id\` | UUID |
| \`tenantId\`, \`organizationId\` | required indexed scope |
| \`kind\` | MVP literal \`move_object\`; additive enum later |
| \`subjectKind\`, \`subjectId\` | semantic target; IDs only |
| \`sourceKind\`, \`sourceId\` | nullable semantic source |
| \`destinationKind\`, \`destinationId\` | required |
| \`contextKind\`, \`contextId\` | optional work-order/etc. reference |
| \`parametersJson\` | bounded typed payload; for WMS demo includes warehouse/catalog variant/quantity/lot/serial as needed |
| \`status\` | state machine below |
| \`originatorUserId\` | nullable FK ID to auth User; no ORM relation |
| \`originatorKind\` | \`human|agent|service|ai_tool\` snapshot |
| \`originContextJson\` | bounded IDs such as agent run/proposal/workflow/conversation/pending-action; never arbitrary prompt text |
| \`selectedExecutorId\` | nullable runtime executor identifier |
| \`latestGateJson\` | bounded latest deterministic check result; no unbounded history |
| lifecycle timestamps | created/updated; no ordinary delete route |

The semantic body is not mutable after authorization. Material changes create a new intent rather than rewriting the authorized object.

### D.2 \`AuthorizationGrant\` — persistent entity

Purpose: scoped authority to let one executor attempt one semantic operation.

Fields:

- UUID + tenant/org;
- \`intentId\`;
- exact \`executorId\`;
- \`actionKind\`;
- exact destination scope;
- \`grantedByUserId\`;
- \`scopeDigest\` over the authorized intent facts;
- \`expiresAt\`;
- \`revokedAt\` nullable;
- created timestamp.

Rules:

- grantor must hold \`reality_layer.authorization.grant\`;
- grantor must resolve to \`auth.User.kind = 'human'\`;
- grantor ID must differ from the human/agent principal that originated the intent;
- grant must match the current intent digest exactly;
- expiry/revocation is rechecked immediately before executor start;
- no secrets or machine credentials are stored here.

### D.3 \`ExecutionRecord\` — persistent entity

Purpose: one dispatch attempt. An intent may have multiple attempts only if no previous physical execution is known to have started, or after explicit compensation/retry policy in future.

Fields:

- UUID + tenant/org;
- \`intentId\`, \`executorId\`;
- monotonically allocated \`attemptNo\`;
- unique \`dispatchKey\`;
- status;
- optional \`externalExecutionId\`;
- \`startedAt\`, \`finishedAt\`;
- \`outcomeCode\`, \`failureCode\`;
- bounded executor metadata that is not evidence.

Execution status is not evidence. A successful executor return creates a separate executor-sourced \`EvidenceEnvelope\`.

### D.4 \`EvidenceEnvelope\` — persistent append-only entity

Purpose: one observation/claim with provenance.

Fields:

- UUID + tenant/org;
- \`intentId\`;
- optional \`executionId\`;
- \`sourceKind\`: \`executor|camera|vlm|barcode|tag|measurement|human|robot|other\`;
- \`sourceId\`;
- \`evidenceType\`: MVP includes \`task_completion_observation\` and \`object_location\`; protocol can add the task's other named types;
- typed/bounded \`claimJson\`;
- optional confidence in [0,1];
- \`observedAt\`, \`recordedAt\`;
- optional bounded artifact references (opaque Open Mercato/media IDs, never secrets/pre-signed credentials);
- bounded provenance: model/detector version, sensor ID, adapter version;
- stable \`externalEventId\` or derived idempotency key.

The entity has **no update/delete API** in the MVP. Corrections are new evidence rows. A unique source/event key collapses duplicate delivery.

### D.5 \`RealityDiff\` — persistent entity

Purpose: durable proposed relationship between a business snapshot and the supported physical observation.

Fields:

- UUID + tenant/org;
- \`intentId\`, \`executionId\`;
- status;
- bounded \`businessBeforeJson\` plus version/digest;
- bounded \`observedJson\`;
- bounded \`proposedChangeJson\`;
- bounded evidence-ID list (MVP hard cap, e.g. 16);
- \`effectAdapterKey\` (MVP \`wms_move\`);
- \`effectCommandId\` snapshot (MVP \`wms.inventory.move\`);
- bounded \`effectInputJson\` deterministic base input;
- decision actor/time;
- \`mergeResultJson\` (e.g. WMS movement ID);
- failure code / retry metadata.

There is no separate \`ReconciliationDecision\` table. Decision commands and their \`ActionLog\` entries provide durable decision history; \`RealityDiff\` stores current outcome.

### D.6 Concepts deliberately not persisted as entities

| Concept | Representation |
|---|---|
| \`PhysicalExecutor\` | DI/runtime interface + registry |
| \`ExecutorCapability\` | immutable descriptor value object |
| \`ExecutorCredential\` | credential-provider decision; secret material stays below boundary |
| \`AuthorizedPhysicalIntent\` | immutable value object produced by successful gate evaluation |
| \`GateCheck\` | bounded value objects in \`latestGateJson\`; historical decisions in ActionLog |
| \`ReconciliationDecision\` | command input + ActionLog |
| \`CompensationRequest\` | future PhysicalIntent kind, not MVP entity |

This avoids entity explosion while preserving every durable fact required by the causal chain.

### D.7 Indexes and cardinality

Minimum supporting indexes:

- intent: \`(tenant_id, organization_id, status, created_at)\`, \`originator_user_id\`;
- grant: \`(tenant_id, organization_id, intent_id, expires_at)\`;
- execution: unique \`(tenant_id, organization_id, intent_id, attempt_no)\`, unique dispatch key;
- evidence: \`(tenant_id, organization_id, intent_id, recorded_at)\`, unique source-event idempotency key;
- diff: \`(tenant_id, organization_id, intent_id, status, created_at)\`.

All JSON fields have schema-level size/count limits. There are no count-growing embedded histories.

## E. State machines

### E.1 PhysicalIntent

The candidate lifecycle is simplified; there is no persisted \`DRAFT\` or \`CHECKING\` state.

\`\`\`text
PENDING
  ├─ gate fails ───────────────> BLOCKED
  ├─ gate passes ──────────────> AUTHORIZED
  └─ user cancels ─────────────> CANCELLED

BLOCKED
  ├─ re-evaluate + passes ─────> AUTHORIZED
  ├─ re-evaluate + fails ──────> BLOCKED
  └─ user cancels ─────────────> CANCELLED

AUTHORIZED
  ├─ dispatch ─────────────────> DISPATCHED
  ├─ gate becomes invalid ─────> BLOCKED
  └─ user cancels pre-dispatch > CANCELLED

DISPATCHED
  ├─ worker starts executor ───> EXECUTING
  ├─ pre-start gate fails ─────> BLOCKED
  └─ queued attempt abandoned ─> AUTHORIZED or BLOCKED after fresh gate

EXECUTING
  ├─ terminal executor result ─> EXECUTED
  └─ failure/timeout ──────────> FAILED

EXECUTED
  └─ reconciliation terminal ──> CLOSED

FAILED
  └─ operator closes/compensates later -> CLOSED

CANCELLED, CLOSED are terminal.
\`\`\`

Owner:
- create/re-evaluate/grant/cancel/dispatch: Reality Layer commands;
- \`DISPATCHED -> EXECUTING\`: execution worker immediately before external call;
- execution terminal transitions: worker;
- close: reconciliation command/policy.

No \`EXECUTING -> CANCELLED\` in MVP: cancellation after physical start is not assumed safe.

### E.2 ExecutionRecord

\`\`\`text
QUEUED -> STARTED -> SUCCEEDED
   |        |-----> FAILED
   |        |-----> TIMED_OUT
   |-----> ABANDONED
   |-----> FAILED (pre-start gate/credential failure)
\`\`\`

Every terminal state is terminal. A late callback after \`FAILED/TIMED_OUT/ABANDONED\` is stored as evidence with a late-event flag; it never rewrites the execution result or auto-mutates business state.

### E.3 RealityDiff

\`\`\`text
PROPOSED
  ├─ request more evidence -> NEEDS_EVIDENCE
  ├─ reject ----------------> REJECTED
  └─ accept ----------------> MERGING

NEEDS_EVIDENCE
  ├─ new evidence + rebuild -> PROPOSED
  └─ reject ----------------> REJECTED

MERGING
  ├─ command succeeds ------> MERGED
  └─ command fails ---------> MERGE_FAILED

MERGE_FAILED
  ├─ retry idempotently ----> MERGING
  ├─ state became stale ----> NEEDS_EVIDENCE
  └─ reject ----------------> REJECTED

MERGED, REJECTED are terminal.
\`\`\`

There is no separate \`ACCEPTED\` state: acceptance atomically claims the merge attempt; the actual business command result determines \`MERGED\`.

## F. Agent Orchestrator and AI Assistant integration

### F.1 Question A — PhysicalIntent vs Agent Orchestrator proposal

A PhysicalIntent may be the **domain object produced from** an approved AO proposal, but it is not the proposal itself. Proposals carry agent reasoning/disposition lifecycle; intents carry physical semantics and persist regardless of agent origin.

### F.2 Question B — disposition/pending action/workflow reuse

- AO disposition decides whether an agent proposal may reach an effector.
- AI Assistant \`prepareMutation\` decides whether an AI mutation tool may execute.
- workflow USER_TASK can represent human business approval.
- none of these is a machine credential or scoped physical grant.

Reuse them where their semantics match; keep \`AuthorizationGrant\` separate.

### F.3 Question C — should physical execution be an effector?

No. An AO effector should call \`reality_layer.intent.create\`. A queue worker later invokes the physical executor after Reality Gate authorization.

### F.4 Question D — feedback to AO/workflows

Reality Layer emits typed lifecycle events with intent/execution/diff IDs. Optional AO/workflow glue may subscribe or signal a waiting workflow. Reality Layer does not import AO or workflows directly.

### F.5 Question E — mechanisms not to overload

Do not overload:

- AO confidence/disposition as physical policy;
- \`AiPendingAction\` as executor permission;
- workflow task status as execution status;
- \`work_orders.Reconciliation\` as RealityDiff;
- human feature RBAC as machine identity.

### F.6 AI tool surface

Safe typed tools:

- \`reality_layer.create_physical_intent\` — **mutation**, therefore subject to the AI mutation approval gate;
- \`reality_layer.get_physical_intent\` — read;
- \`reality_layer.list_available_executors\` — read;
- \`reality_layer.get_reality_diff\` — read;
- \`reality_layer.request_additional_evidence\` — mutation, but does not execute/merge.

Not exposed as AI tools:

- grant authorization;
- change executor credentials;
- force gate result;
- force dispatch;
- accept/merge RealityDiff;
- bypass policy.

Grant and reconciliation commands independently require a human principal server-side, so accidentally granting an agent the corresponding feature is still fail-closed.

## G. Authorization model

Authorization is five separate checks; combining them would create privilege escalation paths.

### G.1 Business actor authorization

Open Mercato feature RBAC answers “may this authenticated actor request/inspect/grant/reconcile?”

Proposed features:

- \`reality_layer.intent.view\`
- \`reality_layer.intent.create\`
- \`reality_layer.authorization.grant\`
- \`reality_layer.execution.dispatch\`
- \`reality_layer.evidence.view\`
- \`reality_layer.diff.view\`
- \`reality_layer.reconciliation.decide\`
- \`reality_layer.executor.view\`

Default demo roles:
- normal operator: view + intent.create + evidence/diff view;
- admin/supervisor: plus authorization.grant, execution.dispatch, reconciliation.decide.

### G.2 Executor capabilities

Semantic claims such as \`move_object\`, \`observe\`, \`identify\`, \`inspect\`, with bounded constraints such as payload/workspace/object class. Capability evaluation is deterministic TypeScript, not an LLM decision.

### G.3 Executor credentials

A provider answers whether executor identity/credential/liveness is acceptable for this task. It returns a decision, never credential material. The Mock provider passes deterministically. A future edge adapter can consult \`edge\`; secrets never enter \`PhysicalIntent\`, queue payloads, logs or evidence.

### G.4 Physical policy

Policy can require a grant for a workspace/risk class, independent verification, or optional safety clearance. MVP policy contains one deterministic restriction so the demo intentionally reaches \`BLOCKED\`.

### G.5 Reconciliation authorization

Accepting physical evidence into ERP truth is a separate privilege. For MVP the decision actor must be a human principal and have \`reality_layer.reconciliation.decide\`. The downstream effect adapter also rechecks the feature(s) required by the target command, e.g. WMS inventory adjustment/move permission.

### G.6 No-self-authorization invariant

Server-side grant command:

1. resolves authenticated user;
2. requires \`User.kind === 'human'\`;
3. requires grant feature;
4. compares grantor with the trusted originator principal recorded at intent creation;
5. rejects equality;
6. computes the grant scope digest from server-loaded intent data;
7. ignores any client-supplied “already authorized” flag.

For AI Assistant origins where the human is operating an agent without a provisioned agent principal, provenance must retain the AI agent/conversation identity separately from the human user. The grantor can be the human; the AI identity cannot become the grantor.

## H. Executor contract

The public business contract contains no ROS, pose, joints, maps or transport details.

\`\`\`ts
export type CapabilityDescriptor = Readonly<{
  kind: 'move_object' | 'observe' | 'identify' | 'inspect' | string
  constraints?: Readonly<Record<string, string | number | boolean>>
}>

export type ExecutorDescriptor = Readonly<{
  executorId: string
  executorKind: 'mock' | 'a1xy' | 'lerobot' | 'bridge' | string
  label: string
  capabilities: readonly CapabilityDescriptor[]
}>

export type AuthorizedPhysicalTask = Readonly<{
  intentId: string
  executionId: string
  kind: 'move_object'
  subject: Readonly<{ kind: string; id: string }>
  source: Readonly<{ kind: string; id: string }> | null
  destination: Readonly<{ kind: string; id: string }>
  context: Readonly<{ kind: string; id: string }> | null
  parameters: Readonly<Record<string, unknown>>
  authorization: Readonly<{
    grantIds: readonly string[]
    evaluatedAt: string
    validUntil: string | null
  }>
}>

export type CapabilityResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: string; messageKey: string }>

export type ExecutionResult = Readonly<{
  outcome: 'success' | 'failure' | 'unexpected_result'
  externalExecutionId?: string
  failureCode?: string
  evidence: readonly EvidenceInput[]
}>

export interface PhysicalExecutor {
  descriptor(): ExecutorDescriptor
  canHandle(task: AuthorizedPhysicalTask): Promise<CapabilityResult>
  execute(
    task: AuthorizedPhysicalTask,
    ctx: Readonly<{ idempotencyKey: string; signal: AbortSignal }>,
  ): Promise<ExecutionResult>
}
\`\`\`

A credential provider is intentionally separate:

\`\`\`ts
export interface ExecutorCredentialProvider {
  evaluate(input: {
    executorId: string
    intentId: string
    actionKind: string
    now: Date
  }): Promise<{ ok: true; validUntil: Date | null } | { ok: false; code: string }>
}
\`\`\`

The task contains authorization facts, not credentials/tokens.

### H.1 MockExecutor

The normative test backend supports:

- \`SUCCESS\`: emits executor completion evidence claiming requested destination;
- \`FAILURE\`: returns a failure and optional observations, no success shortcut;
- \`UNEXPECTED_RESULT\`: execution ends but evidence claims an alternative location such as STAGING-AREA.

The mock outcome is execution-adapter/test configuration, **not part of the semantic PhysicalIntent**. Development UI may pass a bounded mock scenario only when the selected executor is \`mock\`; production configuration rejects it.

### H.2 A1XY / LeRobot adapters

Adapters translate \`AuthorizedPhysicalTask\` to their robotics application/bridge. Internally they may invoke perception, grasp planning, MoveIt/ROS 2/vendor SDK/control and verification. None of those details leak into the Reality Layer interface.

The same executor identifier may denote a robot application or cell rather than a single arm. That is intentional.

## I. VLM and evidence contract

The VLM team owns perception/model execution. Reality Layer owns only evidence ingestion semantics.

### I.1 Boundary

\`\`\`text
camera / detector / VLM / human / second robot
                    |
                    | Observation
                    v
             evidence adapter
                    |
                    | EvidenceInput
                    v
             EvidenceEnvelope
                    |
                    v
               RealityDiff
\`\`\`

A VLM claim is never converted directly into an ERP mutation.

### I.2 \`EvidenceInput\`

\`\`\`ts
export type EvidenceInput = Readonly<{
  sourceKind: 'executor' | 'camera' | 'vlm' | 'barcode' | 'tag' | 'measurement' | 'human' | 'robot' | 'other'
  sourceId: string
  evidenceType:
    | 'object_detected'
    | 'object_identity'
    | 'object_location'
    | 'task_completion_observation'
    | 'barcode_or_tag_observation'
    | 'visual_inspection_result'
    | string
  observedAt: string
  claim: Readonly<Record<string, unknown>>
  confidence?: number
  artifactRefs?: readonly string[]
  externalEventId: string
  provenance?: Readonly<{
    producerVersion?: string
    modelId?: string
    modelVersion?: string
    sensorId?: string
  }>
}>
\`\`\`

Validation rules:

- Zod schema selected by \`evidenceType\`; unknown future types are rejected unless explicitly registered.
- confidence is optional and bounded \([0,1]\); absence is not interpreted as certainty.
- timestamps have bounded skew policy; stale evidence is stored but cannot satisfy a “fresh evidence” policy.
- artifact references are opaque IDs only; no raw credentials, signed URLs or large binary payloads.
- one source/external-event identity maps to at most one envelope.
- evidence creation is append-only.

### I.3 Performer vs verifier

The model supports evidence-policy rules such as:

\`\`\`text
require independent verifier:
  performer executor id != verifier source id
\`\`\`

This is not required for the first MVP path. It is the preferred stretch demo: A1XY-1 performs, LeRobot-1/VLM observes, disagreement moves the diff to \`NEEDS_EVIDENCE\` rather than auto-merging.

### I.4 Conflicting evidence

Evidence resolution is deterministic policy, not LLM judgment. For MVP:

- one supported destination claim and no contradiction → diff may be \`PROPOSED\`;
- contradictory location claims within the same freshness window → \`NEEDS_EVIDENCE\`;
- performer says success but observation says different destination → diff reflects observed destination and is marked conflict/unexpected;
- confidence alone never overrides a conflicting independent claim.

A future policy engine can add thresholds/quorums, but there is no universal “highest confidence wins” rule.

## J. API design

All routes are organization-scoped, Zod-validated, export current Open Mercato per-method \`metadata\` and \`openApi\`, and use the command bus for mutations. Custom action routes use \`runRouteMutationGuards\` (or the equivalent current mutation-guard registry contract) before command execution.

### J.1 MVP routes

| Method | Path | Input / output | Required feature | Semantics | Idempotency |
|---|---|---|---|---|---|
| GET | \`/api/reality_layer/intents\` | bounded filters/page → intents | \`reality_layer.intent.view\` | query | N/A |
| POST | \`/api/reality_layer/intents\` | typed move-object intent + client UUID \`idempotencyKey\` → intent + gate result | \`reality_layer.intent.create\` | command \`reality_layer.intent.create\` | unique origin/idempotency key |
| GET | \`/api/reality_layer/intents/[id]\` | id → intent + current gate summary | \`reality_layer.intent.view\` | query | N/A |
| POST | \`/api/reality_layer/intents/[id]/grants\` | executor, expiry, idempotency key → grant + re-evaluated gate | \`reality_layer.authorization.grant\` | command \`reality_layer.authorization.grant\` | scope digest + idempotency key |
| POST | \`/api/reality_layer/intents/[id]/dispatch\` | executor + idempotency key; dev-only mock scenario → 202 + execution id | \`reality_layer.execution.dispatch\` | command + enqueue | one ExecutionRecord per dispatch key |
| GET | \`/api/reality_layer/executors\` | optional intent id → descriptors/capability result | \`reality_layer.executor.view\` | query | N/A |
| GET | \`/api/reality_layer/intents/[id]/evidence\` | paged evidence | \`reality_layer.evidence.view\` | query | N/A |
| GET | \`/api/reality_layer/diffs\` | paged/filter by intent/status | \`reality_layer.diff.view\` | query | N/A |
| GET | \`/api/reality_layer/diffs/[id]\` | diff + evidence references | \`reality_layer.diff.view\` | query | N/A |
| POST | \`/api/reality_layer/diffs/[id]/decision\` | \`reject|request_more_evidence\` + idempotency key | \`reality_layer.reconciliation.decide\` | command | terminal/current-state guarded |
| POST | \`/api/reality_layer/diffs/[id]/merge\` | idempotency key → merge result | \`reality_layer.reconciliation.decide\` **and** \`wms.adjust_inventory\` for MVP adapter | command → downstream command | RealityDiff UUID is downstream WMS reference id |
| GET | \`/api/reality_layer/intents/[id]/provenance\` | causal graph/timeline | \`reality_layer.intent.view\` | query composed from module rows + ActionLog service | N/A |

The merge route is separate from reject/request-more-evidence so the static route ACL can require the downstream WMS feature only on the operation that can mutate inventory.

### J.2 Optional external evidence ingress

Stretch route:

| Method | Path | Input | Feature | Additional rule |
|---|---|---|---|---|
| POST | \`/api/reality_layer/executions/[id]/evidence\` | \`EvidenceInput\` | \`reality_layer.evidence.submit\` | authenticated human/service principal plus source binding; never exposed as AI tool |

The MockExecutor does not need this route; its worker records evidence internally through the same \`EvidenceRecorder\` service/command.

### J.3 WMS effect mapping

For the move-object vertical slice, \`RealityDiff.effectInputJson\` resolves to the current \`inventoryMoveSchema\` shape. On merge:

\`\`\`ts
{
  warehouseId,
  fromLocationId,
  toLocationId,
  catalogVariantId,
  lotId?,
  serialNumber?,
  quantity,
  type: 'transfer',
  reason: 'Reality Layer accepted physical reconciliation',
  referenceType: 'manual',
  referenceId: realityDiff.id,
  performedBy: reconciliationHumanUserId,
  metadata: {
    realityIntentId,
    realityExecutionId,
    realityDiffId,
  },
  tenantId,
  organizationId,
}
\`\`\`

The current WMS command derives a movement idempotency key including \`referenceType\`, \`referenceId\` and movement facts. Therefore if WMS succeeds and Reality Layer crashes before marking the diff \`MERGED\`, retrying the same merge returns the existing WMS movement rather than duplicating stock movement.

Immediately before calling WMS, Reality Layer re-reads the relevant business state and compares it with the snapshot/digest used to construct the diff. Stale state fails closed and moves/keeps the diff in evidence/review flow; it does not blindly apply an old delta.

### J.4 OpenAPI / MCP implications

Every route receives full \`OpenApiRouteDoc\` metadata. OpenAPI documentation does not itself grant AI authority. Typed \`ai-tools.ts\` controls the intended agent tool surface. High-risk grant/merge routes additionally reject non-human principals server-side, so accidental discovery by an AI/API client does not create a bypass.

## K. Event design

Declare only lifecycle events needed by optional integrations/UI. Events do not drive the core state machine; commands/worker logic do.

\`\`\`ts
const events = [
  { id: 'reality_layer.intent.blocked', entity: 'intent', category: 'lifecycle', clientBroadcast: true },
  { id: 'reality_layer.intent.authorized', entity: 'intent', category: 'lifecycle', clientBroadcast: true },
  { id: 'reality_layer.execution.finished', entity: 'execution', category: 'lifecycle', clientBroadcast: true },
  { id: 'reality_layer.evidence.recorded', entity: 'evidence', category: 'lifecycle', clientBroadcast: true },
  { id: 'reality_layer.diff.proposed', entity: 'diff', category: 'lifecycle', clientBroadcast: true },
  { id: 'reality_layer.diff.merged', entity: 'diff', category: 'lifecycle', clientBroadcast: true },
] as const
\`\`\`

They are registered with \`createModuleEvents({ moduleId: 'reality_layer', events })\`.

Payloads contain only IDs, scope, status/reason codes, and timestamps—not arbitrary evidence bodies or credentials. Persistent delivery is used where workflows/AO may depend on the event; every subscriber must be idempotent. UI refresh can use the existing client event bridge.

## L. UI

The HackOn UI is intentionally two pages.

### L.1 Reality Layer dashboard

\`/backend/reality-layer\`

Use Open Mercato \`DataTable\` with stable entity ID/table extension ID. Columns:

- intent ID / subject;
- requested action;
- status;
- selected executor;
- latest gate result;
- created time;
- originator kind.

Actions:
- create move-object intent (via \`CrudForm\` or a CrudForm-compatible create flow);
- open detail.

### L.2 Intent detail

\`/backend/reality-layer/intents/[id]\`

One page, not six separate screens. Sections:

1. semantic intent;
2. Reality Gate checks;
3. authorization grants;
4. execution attempts;
5. evidence list;
6. RealityDiff/reconciliation;
7. provenance activity feed.

Use shared \`StatusBadge\`, \`Alert\`, \`ActivityFeed\`, \`DataTable\`, \`Button\`, \`useConfirmDialog\`, i18n, and semantic design-system tokens. All action writes use \`useGuardedMutation\` plus \`apiCall\`/canonical helpers—no raw \`fetch\`.

The mock scenario selector appears only in development/demo mode when executor kind is \`mock\`.

The key judge-facing moment is explicit UI state:

\`\`\`text
Execution: SUCCEEDED
Evidence: received
Business state: UNCHANGED
RealityDiff: PROPOSED
[Merge into business reality]
\`\`\`

### L.3 Frontend boundary

Keep route pages/server metadata small. Interactive lifecycle actions live in focused client components; do not turn the entire backend page into one client blob. No new provider/global shell code is required. The implementation PR must include the current Open Mercato frontend architecture/performance checks required for touched backend pages.

## M. Audit and provenance

### M.1 Causal graph

The target navigation is:

\`\`\`text
WMS InventoryMovement / business mutation
          ^
          | referenceId = RealityDiff.id
          |
RealityDiff -- merge ActionLog
          ^
          |
EvidenceEnvelope(s)
          ^
          |
ExecutionRecord
          ^
          |
AuthorizationGrant(s)
          ^
          |
PhysicalIntent -- create ActionLog
          ^
          |
human / AI pending action / AO proposal+run / workflow
\`\`\`

Reality Layer persists foreign IDs, never cross-module ORM relations.

### M.2 Canonical audit

Every Reality Layer mutation is a registered command with \`buildLog\` metadata:

- resource kind/id;
- tenant/org;
- actor;
- parent/related Reality Layer resource IDs;
- before/after snapshots where safe;
- reason/status codes;
- provenance IDs.

For agent-originated commands, the existing \`CommandRuntimeContext.runAs\`/ActionLog path remains the source of actor/on-behalf-of attribution. Reality Layer does not invent “agent audit” fields that compete with it.

### M.3 Provenance endpoint

The provenance query composes:

- module-owned rows;
- command/action-log references through the audit service/API;
- origin context IDs;
- downstream business movement ID.

It never reads another module's tables through direct ORM imports.

## N. Failure semantics

The physical world and database cannot share one atomic transaction. Failure behavior is therefore explicit.

| Case | Required behavior | MVP? |
|---|---|---|
| Executor never starts | queued attempt becomes \`ABANDONED\` or pre-start \`FAILED\`; no physical success inferred; intent may return to authorized/blocked after fresh gate | MUST |
| Started then fails | \`FAILED\`; preserve any evidence; no business mutation | MUST |
| Timeout | \`TIMED_OUT\`; later callback becomes late evidence only | MUST |
| Disconnect | failure/timeout code; credential/liveness must be rechecked before retry | SHOULD |
| Duplicate completion | dedupe by external event ID; terminal execution state unchanged | MUST |
| Late completion | append evidence tagged late; never rewrite terminal result or auto-merge | MUST |
| Out-of-order evidence | append; diff builder reasons from timestamps/provenance, not arrival order | MUST |
| Physical success, merge fails | diff \`MERGE_FAILED\`; retry downstream effect idempotently | MUST |
| ERP cancellation after physical start | cancellation does not pretend rollback; execution continues to terminal and requires reconciliation/compensation | MUST policy, UI may defer |
| Unexpected physical outcome | evidence reflects actual claim; diff shows actual observed target; business state unchanged until human decision | MUST |
| Conflicting evidence | \`NEEDS_EVIDENCE\`; merge blocked | MUST |
| Grant expires while queued | worker re-runs gate before start; execution not started | MUST |
| Queue abandons job before handler | worker \`onJobAbandoned\` reports idempotently; domain staleness sweep is post-hackathon hardening | MUST basic |
| Diff snapshot stale before merge | 409/fail closed; no downstream command; rebuild/review | MUST |
| Downstream WMS succeeds, RL final status write fails | merge retry uses same diff UUID reference and resolves existing WMS movement | MUST |

### N.1 Compensation

Compensation is not generic undo. Future compensation is a new PhysicalIntent (e.g. move object back) linked to the failed/original intent. For MVP, UI displays “manual/compensation required” but does not auto-command a reverse motion.

## O. Formal model seed

### O.1 Smallest transition system

Do not formalize ROS, trajectories, kinematics, VLM internals or WMS arithmetic. Formalize only:

\`\`\`text
ActorId, ExecutorId, IntentId, EvidenceId, DiffId
IntentStatus
ExecutionStatus
DiffStatus
Grant(valid, actor, executor, scope, expiry)
Evidence(source, provenance)
BusinessEffect(diffId)
\`\`\`

Actions:

- \`CreateIntent\`
- \`EvaluateGate\`
- \`Grant\`
- \`Dispatch\`
- \`StartExecution\`
- \`FinishExecution\`
- \`RecordEvidence\`
- \`ProposeDiff\`
- \`RequestEvidence\`
- \`RejectDiff\`
- \`MergeDiff\`
- \`DuplicateExternalEvent\`

### O.2 Target invariants

1. **Authorization before start**  
   \`StartExecution(i,e) ⇒\` a valid gate result and non-expired matching grant existed immediately before start.

2. **No self-authorization**  
   every valid grant has a human grantor distinct from the intent originator principal.

3. **Execution is not mutation**  
   \`ExecutionStatus = SUCCEEDED\` alone does not change \`BusinessState\`.

4. **Evidence is not truth**  
   \`RecordEvidence\` alone does not change \`BusinessState\`.

5. **Reconciliation witness**  
   every business mutation caused by physical observation has a corresponding accepted merge attempt for a RealityDiff.

6. **At-most-once business effect**  
   duplicate/retried merge for the same diff produces at most one logical downstream business movement.

7. **Failure cannot silently succeed**  
   a failed execution cannot transition to \`SUCCEEDED\` without a distinct new execution attempt.

8. **Provenance totality**  
   every evidence row accepted into a diff has source identity and timestamp; every merged diff refers to evidence.

9. **Independent verification**  
   when policy requires independent verification, the performer executor identity differs from the qualifying verifier source identity.

10. **Terminal monotonicity**  
    terminal execution and terminal diff states never reopen through duplicate/late events.

### O.3 Verification strategy

- First: pure TypeScript transition/gate functions + exhaustive small-state tests.
- TLA+ or a small explicit model checker is well suited to duplicate/reordered/late event schedules and crash points around merge.
- Lean 4 is the target for inductive reachability proofs of invariants 1–10 over the abstract transition relation.
- The Lean model should model idempotency as a logical effect set keyed by diff ID, not PostgreSQL/WMS implementation details.

## P. Protocol extraction

### P.1 Open Mercato-specific implementation concepts

- feature-based RBAC IDs;
- \`auth.User.kind\`;
- \`CommandBus\` / \`ActionLog\`;
- \`prepareMutation\` / \`AiPendingAction\`;
- AO proposals/dispositions/effectors;
- workflows USER_TASK / WAIT_FOR_SIGNAL;
- Open Mercato queue worker metadata;
- WMS \`wms.inventory.move\`;
- OpenAPI/AI-tool generation;
- DataTable/CrudForm/UI details.

### P.2 Candidate vendor-neutral protocol semantics

Potentially portable:

- \`PhysicalIntent\`;
- \`CapabilityDescriptor\`;
- \`AuthorizationContext\` / grant reference;
- \`ExecutionAcknowledgement\` / execution attempt;
- \`EvidenceEnvelope\`;
- \`RealityDiff\`;
- standardized failure codes;
- \`CompensationRequest\`.

The protocol should describe semantic messages and invariants, not dictate HTTP/MQTT/ROS 2. Transport binding is a later layer.

## Q. Tests

### Q.1 Unit tests

Minimum cases:

1. gate rejects structurally/source-invalid intent;
2. gate rejects capability mismatch;
3. gate rejects missing/expired grant;
4. grant command rejects agent/service grantor;
5. grant command rejects same originator/grantor;
6. grant scope digest cannot authorize modified intent;
7. legal/illegal state transitions;
8. executor registry returns only compatible descriptors;
9. MockExecutor SUCCESS/FAILURE/UNEXPECTED_RESULT contract;
10. EvidenceInput validation and duplicate event collapse;
11. conflicting evidence → \`NEEDS_EVIDENCE\`;
12. RealityDiff WMS mapping is deterministic;
13. stale business snapshot blocks merge;
14. downstream input uses \`referenceId = diff.id\`.

### Q.2 Integration/API tests

Use module-local \`__integration__\` and Open Mercato integration helpers.

Critical vertical-slice test:

1. create WMS fixture item at STORAGE-A;
2. operator creates PhysicalIntent;
3. assert status \`BLOCKED\`, no execution;
4. same operator tries grant → rejected;
5. supervisor grants exact executor/action/destination;
6. gate becomes \`AUTHORIZED\`;
7. dispatch MockExecutor SUCCESS;
8. drain queue;
9. execution \`SUCCEEDED\`, evidence exists, diff \`PROPOSED\`;
10. assert WMS/business state is **still STORAGE-A**;
11. supervisor merges diff;
12. assert one WMS movement and destination REPAIR-BENCH;
13. retry merge;
14. assert still exactly one logical movement;
15. provenance endpoint links WMS movement back to diff/evidence/execution/grant/intent/origin.

Security/integrity integration tests:

- cross-tenant intent/evidence/diff IDs return scoped 404/no oracle;
- agent principal cannot create grant even with feature;
- agent principal cannot merge diff even with feature;
- expired grant while job waits prevents executor start;
- duplicate queue job is no-op after terminal attempt;
- duplicate executor external event creates no second evidence row;
- late success after timeout creates evidence but does not mutate execution/business status;
- unexpected destination never auto-updates ERP;
- conflicting witness prevents merge;
- missing optional \`fleet/edge/safety/vision\` modules does not break MockExecutor baseline.

### Q.3 Executor contract suite

A reusable suite runs against every adapter:

- stable descriptor;
- deterministic capability result for declared fixtures;
- same idempotency key never intentionally launches two logical tasks;
- abort/timeout mapping;
- no business credentials visible to adapter;
- evidence carries source/provenance;
- transport errors map to bounded failure codes.

MockExecutor must pass the suite first; A1XY/LeRobot adapters are accepted only when they pass the same suite.

## R. Implementation plan

Every phase ends in a runnable/testable application. No core patch is planned.

### M0 — architecture/spec gate **(current branch)**

1. repository analysis against pinned Open Mercato SHA;
2. complete this blueprint;
3. adversarial second pass;
4. human review/approval.

**Exit:** reviewed spec. No implementation before exit.

### M1 — module skeleton + persistence

1. add \`reality_layer\` module metadata/ACL/setup/DI;
2. add five entities + migration + Zod validators;
3. register commands for create/grant/state transitions;
4. unit-test tenant/org scoping and legal transitions.

**Exit:** create/query an intent and grant in an app with no robotics modules.

### M2 — Reality Gate

1. pure deterministic gate service;
2. business source-state adapter for WMS vertical slice;
3. executor registry/capability check;
4. Mock credential provider;
5. scoped grant policy + expiry/no-self-authorization.

**Exit:** deterministic BLOCKED → grant → AUTHORIZED flow.

### M3 — MockExecutor + asynchronous dispatch

1. executor types/registry + MockExecutor;
2. queue helper + \`execution.worker.ts\`;
3. dispatch command creates ExecutionRecord before enqueue;
4. worker re-runs gate immediately before start;
5. \`onJobAbandoned\` mapping;
6. SUCCESS/FAILURE/UNEXPECTED_RESULT tests.

**Exit:** no physical robot required; complete execution ledger.

### M4 — evidence + RealityDiff

1. append-only evidence command/service;
2. executor result → distinct executor evidence;
3. evidence conflict/freshness policy;
4. deterministic RealityDiff builder;
5. diff query/detail APIs.

**Exit:** robot can say DONE while ERP truth remains unchanged.

### M5 — reconciliation/WMS business effect

1. decision command;
2. WMS move effect adapter using \`referenceId = diff.id\`;
3. stale business-state recheck;
4. merge failure/retry semantics;
5. exact-once logical movement integration tests.

**Exit:** explicit human merge is the only path that updates WMS.

### M6 — HackOn UI + provenance

1. dashboard DataTable;
2. intent detail with gate/grant/execution/evidence/diff;
3. mock outcome selector in demo mode;
4. ActivityFeed/provenance graph;
5. guarded mutations, i18n, OpenAPI, design-system checks.

**Exit:** complete judge-facing vertical slice.

### M7 — AI surface

1. safe read tools;
2. \`create_physical_intent\` mutation tool through current AI mutation approval path;
3. no grant/merge/force tools;
4. tests showing agent cannot self-grant or merge.

**Exit:** AI can request, not authorize physical authority.

### M8 — A1XY adapter

Thin bridge implementation below \`PhysicalExecutor\`; no domain changes.

### M9 — LeRobot/VLM evidence adapter

Add second hardware adapter and/or external evidence source. Prefer performer/witness demo over multi-robot motion planning.

### M10 — formal model seed

1. encode abstract states/actions in Lean 4;
2. prove authorization-before-start, no-self-grant, no-evidence-to-truth;
3. model/exhaust duplicate/late event schedules in a finite checker/TLA+ if useful;
4. connect executable state transition tests to the same transition table.

## S. Hackathon cut line

### MUST HAVE

- M0 approved blueprint;
- M1 five-entity domain + command/audit path;
- M2 deterministic gate + scoped grant + no-self-authorization;
- M3 MockExecutor queue path;
- M4 append-only evidence + RealityDiff;
- M5 explicit WMS merge with retry idempotency;
- M6 minimal dashboard/detail/provenance UI;
- one complete integration test proving “execution succeeded, business state unchanged until merge”;
- duplicate completion/merge and cross-tenant/no-self-authorization tests.

### SHOULD HAVE

- M7 safe AI intent creation/read surface;
- external evidence ingress boundary;
- first Lean 4 transition-system seed;
- optional \`edge\` credential/liveness adapter or \`fleet\` capability adapter.

### STRETCH

- A1XY executor;
- LeRobot executor;
- VLM evidence;
- independent performer/witness policy;
- Agent Orchestrator proposal→intent adapter;
- workflow waiting/signalling demo.

### POST-HACKATHON

- generalized business-effect adapter catalog;
- compensation intent semantics;
- durable stale-operation sweeper/operational monitoring;
- protocol versioning and transport bindings;
- richer evidence policies;
- full formal proof suite/model checking;
- vendor-neutral whitepaper/specification.

## T. Open questions

These do not block writing the blueprint; they are the explicit human-review decisions before/while implementation proceeds.

1. **Business fixture:** should HackOn use existing WMS catalog variant/location IDs directly for PART-17/STORAGE-A/REPAIR-BENCH? **Recommendation: yes**, to reuse \`wms.inventory.move\`.
2. **Two-person rule:** should a human who manually created an intent be forbidden from granting it, or is no-self-grant required only for AI/service origin? **Current safe default: forbid same principal for all origins.**
3. **Restricted policy:** which concrete demo workspace/destination should intentionally require a grant? **Recommendation: REPAIR-BENCH.**
4. **Executor registry:** static DI registrations vs configuration-driven registry for HackOn? **Recommendation: static DI first.**
5. **External VLM ingress:** service-account HTTP evidence route vs local event/adapter? **Recommendation: service-account route only when VLM team needs process separation.**
6. **Artifact storage:** which existing Open Mercato media/file abstraction should hold images/clips? Until selected, store only opaque references.
7. **Object quantity:** represent PART-17 as quantity 1 of a WMS catalog variant, or add serial tracking for the demo? **Recommendation: quantity 1; serial only if existing fixture supports it cleanly.**
8. **AO availability:** will HackOn environment include enterprise Agent Orchestrator? Core MVP must not depend on it either way.
9. **Robot bridge:** A1XY/LeRobot direct SDK, ROS 2 service/action, or team-provided HTTP bridge? Adapter contract deliberately defers this.
10. **Formal deliverable timing:** is a compiling Lean 4 seed part of HackOn judging or immediate post-hackathon? Architecture is unchanged.

## Exact proposed code layout

Source in this repository:

\`\`\`text
mercato/modules/reality_layer/
  index.ts
  acl.ts
  setup.ts
  di.ts
  events.ts
  ai-tools.ts                         # M7, not needed M1-M6

  data/
    entities.ts
    validators.ts

  commands/
    index.ts
    intents.ts
    authorization.ts
    executions.ts
    evidence.ts
    reconciliation.ts

  lib/
    types.ts
    gate.ts
    stateMachine.ts
    queue.ts
    realityDiff.ts
    provenance.ts

    executors/
      types.ts
      registry.ts
      mock.ts

    credentials/
      types.ts
      mock.ts

    effects/
      types.ts
      wmsMove.ts

  workers/
    execution.worker.ts

  api/
    openapi.ts
    intents/
      route.ts
      [id]/
        route.ts
        grants/route.ts
        dispatch/route.ts
        evidence/route.ts
        provenance/route.ts
    executors/route.ts
    diffs/
      route.ts
      [id]/
        route.ts
        decision/route.ts
        merge/route.ts
    executions/
      [id]/
        evidence/route.ts             # stretch external ingress

  backend/
    reality-layer/
      page.meta.ts
      page.tsx
      intents/
        [id]/
          page.meta.ts
          page.tsx

  components/
    RealityLayerDashboard.tsx
    RealityIntentDetail.tsx

  i18n/
    en.json
    pl.json

  migrations/
    MigrationYYYYMMDDHHMMSS_reality_layer.ts

  __tests__/
    gate.test.ts
    stateMachine.test.ts
    authorization.test.ts
    evidence.test.ts
    realityDiff.test.ts
    mockExecutor.test.ts
    wmsMoveEffect.test.ts

  __integration__/
    TC-REALITY-001-vertical-slice.spec.ts
    TC-REALITY-002-no-self-authorization.spec.ts
    TC-REALITY-003-idempotent-merge.spec.ts
    TC-REALITY-004-unexpected-result.spec.ts
    TC-REALITY-005-cross-tenant.spec.ts
\`\`\`

No \`runtime.ts\` is required. Migrations are module-owned. The installer already copies \`mercato/modules/*\` into the Open Mercato app and runs generation.

## Second-pass adversarial review

The task explicitly requires a second pass. Results:

1. **Which parts duplicate Open Mercato mechanisms?**  
   Removed parallel approval/audit/event/workflow ideas. AI mutation approval remains \`prepareMutation\`; audit remains \`ActionLog\`; asynchronous work remains Queue; business effect remains WMS command.

2. **Which parts are unnecessary for HackOn?**  
   No persistent Executor/Capability/Credential/GateEvaluation/ReconciliationDecision entities; no workflow definition; no runtime loop; no generic ontology; no auto-compensation.

3. **Which abstractions leak robotics details upward?**  
   Executor interface has only semantic task/capability/evidence. Pose, joint state, battery, map, MoveIt and ROS messages are absent.

4. **Which authorization paths permit escalation?**  
   Main risks are agent/service grant, same-originator grant, downstream WMS bypass, client-supplied authorization scope. Mitigations are human-kind check, principal inequality, server-derived scope digest, separate merge feature plus WMS feature.

5. **Where can retries duplicate effects?**  
   Dispatch key, executor idempotency key, evidence externalEventId and WMS diff UUID reference are separate dedupe boundaries. Worker/event subscribers are explicitly idempotent.

6. **Where can an AI bypass approval?**  
   Grant/merge/force are absent from typed AI tools and reject non-human principals. AI-created intent remains a mutation behind the existing AI approval path.

7. **Which data is append-only?**  
   Evidence is append-only. ActionLog is canonical immutable audit history. WMS movement is append-only domain ledger. Execution attempts are never rewritten into a different attempt.

8. **Which assumptions block humanoid/AMR/drone support?**  
   None in the executor contract: no pose/joint/map/battery fields and executor may denote an application/cell/controller rather than a robot.

9. **Smallest coherent formal state machine?**  
   Intent + execution + diff status, grants/evidence/effect set. Five persisted entities are enough; formal model needs fewer data fields.

10. **Can MVP run without any physical robot?**  
    Yes. MockExecutor is the normative reference and exercises every trust boundary including unexpected outcome.

### Review — 2026-09-19

- **Reviewer:** Agent architecture pass; human review pending
- **Security:** design pass; no-self-grant, separate machine credentials, tenant scope and downstream authorization specified
- **Performance:** bounded JSON/arrays, indexed list paths, asynchronous physical I/O
- **Cache:** no custom cache required for MVP; canonical command/data mechanisms own business cache invalidation
- **Commands:** all state changes command-backed; physical/WMS reversal modeled as counter-action, not generic undo
- **Risks:** critical retry/late-event/stale-state paths specified
- **Verdict:** **Ready for human architecture review; implementation not yet authorized**

## RECOMMENDED ARCHITECTURE

A self-contained \`reality_layer\` Open Mercato app module with five persistent entities, deterministic Reality Gate, separate human authorization and executor credential providers, queue-backed replaceable \`PhysicalExecutor\`, append-only evidence, explicit RealityDiff, and command-backed human reconciliation into domain truth.

## HACKATHON CUT LINE

Finish MockExecutor end-to-end first. The demo is successful before any A1XY/LeRobot code exists if it proves:

\`\`\`text
intent -> blocked -> human scoped grant -> execute -> evidence -> diff
       -> business state still unchanged -> explicit merge -> one audited WMS mutation
\`\`\`

Hardware/VLM integration is additive after that invariant is visible.

## FIRST 10 IMPLEMENTATION TASKS

1. Add module skeleton, ACL/setup/DI and migration.
2. Implement five entities and strict Zod schemas.
3. Implement pure state transition table and tests.
4. Implement \`reality_layer.intent.create\` + query APIs.
5. Implement Reality Gate with WMS source-state check and Mock capability/credential providers.
6. Implement human-only scoped grant command + no-self-authorization tests.
7. Implement executor registry, MockExecutor, dispatch command and queue worker.
8. Implement append-only evidence + conflict handling + RealityDiff builder.
9. Implement WMS merge adapter using RealityDiff UUID as WMS idempotency reference.
10. Implement dashboard/detail/provenance UI and the full Playwright vertical-slice/idempotency/security test.

## TOP 10 OPEN QUESTIONS

1. Strict two-person rule for human-created intents, or only for agent/service origin?
2. Exact WMS fixture IDs/model for PART-17 and two locations?
3. Exact restricted workspace used to demonstrate BLOCKED?
4. Static vs configured executor registry after HackOn?
5. VLM evidence ingress mechanism?
6. Artifact/image storage abstraction?
7. Serial-tracked vs quantity-1 component semantics?
8. Agent Orchestrator available in judging environment?
9. A1XY/LeRobot bridge transport?
10. Lean 4 seed required before judging or immediately afterward?

## TOP 10 FAILURE / SECURITY CASES

1. Agent attempts to grant its own intent.
2. Same human originator attempts self-grant under strict two-person policy.
3. Grant expires while execution waits in queue.
4. Queue delivers the same dispatch twice.
5. Executor sends duplicate completion.
6. Timeout is followed by a late success callback.
7. Performer and independent observer disagree.
8. Physical move succeeds but WMS merge initially fails/crashes.
9. Business inventory changes between evidence capture and merge.
10. Cross-tenant or forged IDs are used to read/grant/merge another organization's operation.

## Human review gate

**STOP HERE before implementation.** The attached task explicitly requires human review after the blueprint. Once a human approves this architecture (and resolves any desired open questions), implementation can proceed phase-by-phase on a separate implementation branch based on this design branch or directly from \`physical_ai\` with this spec carried forward.
