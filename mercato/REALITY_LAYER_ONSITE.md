# Reality Layer — on-site completion runbook

Branch prepared off-site:

```
reality-layer-offsite-hardening
```

Base:

```
reality-layer-debug-integration
```

This branch intentionally does **not** contain the local Qwen/Open Mercato platform patches from
`/home/ljaniec/Repositories/open-mercato`. Preserve those local changes separately; do not reset or
clean that checkout.

## What is already encoded

- G4 worker discovery: after `yarn generate`, the runner requires
  `reality-layer:execution` to occur in generated module metadata.
- G5 HTTP: BLOCKED without grant, then human grant, then AUTHORIZED.
- G6 queue/worker: dispatch through `MockExecutor`, poll status until terminal execution,
  evidence and diff.
- G7 ERP unchanged before reconciliation: optional WMS test queries movements by
  `referenceId = RealityDiff.id` and requires zero rows before merge.
- G8 merge: human reconciliation must create exactly one WMS transfer.
- G9 replay/idempotency: after retry/replay, movement query by the same diff id must still
  contain exactly one row.
- G10 failure and `unexpected_result`: failure produces no successful evidence/diff;
  unexpected destination is recorded and automatic merge is refused.

## 1. Get this branch without touching the Open Mercato checkout

In the extension repository/worktree:

```bash
git fetch origin reality-layer-offsite-hardening
git switch reality-layer-offsite-hardening
```

If the existing Reality Layer worktree must remain on another branch, create another worktree
instead:

```bash
git fetch origin reality-layer-offsite-hardening
git worktree add ../openmercato-reality-hardening origin/reality-layer-offsite-hardening
cd ../openmercato-reality-hardening
```

## 2. Preserve Qwen patches first

The local Open Mercato checkout currently contains hackathon platform patches and injected modules.
Do not run `git reset --hard`, `git clean`, or manually remove `.next` / `.mercato/next`.

The earlier preservation commit captured `apps/mercato/next.config.ts`; also preserve every current
`apps/mercato/scripts/*.client-stub.js` before debugging further.

## 3. Run static/build gates

From this repository branch:

```bash
MERCATO_ROOT=/home/ljaniec/Repositories/open-mercato \
  bash mercato/run-reality-layer-gates.sh
```

Logs:

```
/tmp/reality-layer-gates/
```

The runner stops at the first failing gate but exits only its child shell.

Expected sequence:

```
01-install
02-build-packages
03-generate
04-worker-discovery
05-build-packages-after-generate
06-typecheck
07-unit-tests
08-webpack-build
```

The production build is intentionally:

```
next build --webpack
```

because the hackathon Open Mercato checkout carries a custom Webpack replacement configuration.

## 4. Start Open Mercato

Use the normal starter/runtime after the Qwen platform patch is stable, for example:

```bash
cd /home/ljaniec/Repositories/open-mercato
corepack yarn om up --non-interactive --skip-llm-prompt
```

Do not manually delete generated build directories while the supervisor is running.

## 5. Run HTTP + queue E2E

When `http://localhost:3000` is reachable:

```bash
RUN_REALITY_E2E=1 \
MERCATO_ROOT=/home/ljaniec/Repositories/open-mercato \
BASE_URL=http://localhost:3000 \
bash mercato/run-reality-layer-gates.sh
```

The E2E suite is:

```
mercato/modules/reality_layer/__integration__/TC-REALITY-001-mvp.spec.ts
```

It uses the standard Open Mercato integration users:

- `employee`: creates the intent;
- `admin`: grants authorization, evaluates the gate, dispatches and reconciles.

Using two principals is deliberate: the Reality Layer forbids self-authorization.

## 6. WMS exactly-once proof is self-contained

No WMS UUIDs or pre-existing stock fixture are required.

`TC-REALITY-002` creates a disposable fixture through the normal Open Mercato APIs:

```
catalog product + variant
→ WMS warehouse
→ source + destination locations
→ inventory profile
→ +5 source inventory adjustment
→ Reality Layer move intent for quantity 1
```

It then checks the actual WMS ledger by:

```
GET /api/wms/inventory/movements?referenceId=<RealityDiff.id>
```

Required observations:

```
before reconciliation: 0 movements
after merge:           1 movement
after merge replay:    1 movement
```

It also requires the final Reality Layer state to be:

```
PhysicalIntent CLOSED
RealityDiff MERGED
```

The fixture is removed in a `finally` block after the test. This verifies the ERP boundary against
a real platform-owned WMS mutation rather than only checking Reality Layer state.

## 7. Debugging interpretation

If `03-generate` fails, inspect:

```
/tmp/reality-layer-gates/03-generate.log
```

If `04-worker-discovery` fails, the worker was not emitted into the generated registry; do not
debug queue execution yet.

If `09-e2e` times out with an execution stuck in `queued`, worker discovery may have succeeded
but no worker runtime is consuming `reality-layer-execution`. Start or inspect:

```bash
cd /home/ljaniec/Repositories/open-mercato
corepack yarn mercato queue worker reality-layer-execution
```

and rerun the E2E suite.

If the generic happy path passes but WMS reconciliation fails, inspect the fixture first:
warehouse/location membership, source available quantity, and the variant inventory profile.

## Merge boundary

Do not merge PR #2/#3/#4 solely because generation/typecheck passes.

Merge-ready means:

```
G0 unit/migration/ACL
G1 Qwen patches preserved
G2 build/typecheck
G3 app serves
G4 worker discovered
G5 BLOCKED -> grant -> AUTHORIZED
G6 queue -> execution -> evidence -> diff
G7 no ERP mutation before reconciliation
G8 exactly one WMS move
G9 replay remains exactly one move
G10 failure + unexpected_result E2E
```
