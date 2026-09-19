# Reality Layer MVP — hackathon runbook

## Definition of done

The MVP is complete when this invariant is visible:

```text
PhysicalIntent
  -> BLOCKED
  -> human AuthorizationGrant
  -> AUTHORIZED
  -> queued MockExecutor
  -> ExecutionRecord SUCCEEDED
  -> EvidenceEnvelope
  -> RealityDiff PROPOSED
  -> WMS STILL UNCHANGED
  -> human reconciliation.merge
  -> one WMS movement
  -> RealityDiff MERGED / intent CLOSED
```

An `unexpected_result` must instead produce `manual_review` and must not have a
safe automatic ERP effect.

## Branch stack

- M1: `reality-layer-physical-ai`
- M2: `reality-layer-m2`
- MVP M3-M5: `reality-layer-mvp-speedrun`

Do not merge the stack until the local M1 compile/migration repair is applied.

## Local verification after M1 repair

```bash
git checkout reality-layer-mvp-speedrun
./mercato/install.sh reality_layer

cd /path/to/open-mercato/apps/mercato
yarn generate
yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn test --testPathPatterns "modules/reality_layer"
```

Run the app with workers enabled (default development mode) or explicitly:

```bash
yarn mercato queue worker reality-layer-execution
```

The queue name is `reality-layer-execution`; `yarn dev` should auto-spawn it in development.

## Command sequence

1. `reality_layer.intent.create` — create a semantic `move_object` request.
2. `reality_layer.gate.evaluate` — expected `BLOCKED` with `grant_missing`.
3. A different authenticated human runs `reality_layer.authorization.grant`.
4. Re-run `reality_layer.gate.evaluate` — expected `AUTHORIZED`.
5. `reality_layer.execution.dispatch` with `executorId = mock:cell-1` and scenario `success`.
6. Drain/run the `reality-layer-execution` worker.
7. Inspect the rows: execution is terminal, evidence exists, diff is `PROPOSED`.
8. Verify WMS has not moved yet.
9. Human runs `reality_layer.reconciliation.merge`.
10. Verify exactly one WMS movement has `reference_id = RealityDiff.id`.

## WMS intent parameters

For the automatic WMS merge path, the intent must use:

```json
{
  "kind": "move_object",
  "subjectKind": "catalog_variant",
  "subjectId": "<catalog variant UUID>",
  "sourceKind": "wms_location",
  "sourceId": "<source location UUID>",
  "destinationKind": "wms_location",
  "destinationId": "<destination location UUID>",
  "parameters": {
    "warehouseId": "<warehouse UUID>",
    "quantity": 1
  }
}
```

Optional `lotId`, `serialNumber`, `massKg`, and `mockUnexpectedDestinationId`
remain inside `parameters`.

## Three judge scenarios

### A. Happy path

`mockScenario = success`: evidence agrees with requested destination; WMS changes only after merge.

### B. Physical failure

`mockScenario = failure`: execution becomes FAILED; no evidence-based WMS effect exists.

### C. Unexpected physical outcome

`mockScenario = unexpected_result`: evidence records a different location;
`RealityDiff.effectAdapterKey = manual_review`; automatic merge is rejected.

## What is intentionally postponed

- A1XY/LeRobot transport adapters;
- VLM evidence HTTP ingress;
- full backend dashboard;
- compensation automation;
- queue abandonment sweeper;
- Lean/TLA+ proof artifacts.

These are additive. The MVP claim does not depend on them.
