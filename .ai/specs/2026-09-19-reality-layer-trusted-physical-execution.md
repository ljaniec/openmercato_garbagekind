# Reality Layer: Trusted Physical Execution for Agentic ERP

**Status:** Draft architecture blueprint — implementation intentionally blocked pending human review  
**Date:** 2026-09-19  
**Target repository branch:** `physical_ai` → design branch `reality-layer-blueprint`  
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
2. **AI pending actions are not physical grants.** `prepareMutation` remains the AI-framework gate for AI-initiated database writes such as creating an intent. It does not authorize a robot to act.
3. **Agent Orchestrator is an optional intent origin.** An approved Agent Orchestrator effector may create a PhysicalIntent through the command bus. It must not synchronously command hardware.
4. **Physical dispatch is asynchronous.** An Open Mercato queue worker owns execution attempts. HTTP/API handlers never wait for a robot operation.
5. **Evidence is append-only.** Executor/VLM/camera/barcode/human observations are claims with provenance, not business truth.
6. **RealityDiff is a separate abstraction from `work_orders.Reconciliation`.** The existing work-orders reconciliation compares robot piece claims with scale mass and may directly receive inventory; it has different semantics.
7. **The business mutation happens last.** Reconciliation acceptance invokes an existing command such as `wms.inventory.move`; no cross-module table write is allowed.
8. **MockExecutor is normative.** It is the reference implementation and contract test target, not disposable demo code.
9. **Fail closed.** Unknown capability, missing credential status, incomplete policy result, expired grant, stale business precondition, or ambiguous evidence blocks advancement.
10. **Idempotency is end-to-end.** Intent submission, dispatch, executor callback/evidence ingestion, diff creation, and reconciliation merge each have their own stable idempotency boundary.

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

## Human review gate

Implementation must not begin until this specification has been expanded through the full repository findings, data/state/API/security/test plan and reviewed by a human. Any implementation commit before that review is out of scope for this branch.
