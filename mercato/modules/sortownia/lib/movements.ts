import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { InventoryMovement, type WarehouseLocation } from '@open-mercato/core/modules/wms/data/entities'
import { buildMovementIdempotencyKey } from '@open-mercato/core/modules/wms/lib/inventoryIdempotency'
import { legacyUuid, type LegacyMovementRow } from './legacyFiles'
import type { FractionIndex } from './fractions'

/**
 * Księga ruchów legacy przełożona na operacje WMS.
 *
 * Trzy rzeczy dzieją się tu naraz i każda z nich jest tym, czego stary system
 * nie potrafił:
 *
 * 1. `SORT` w legacy to PARA wierszy (minus na placu, plus w boksie), które
 *    nic nie wiąże poza tym, że mają tę samą sekundę. W WMS to jeden ruch
 *    `transfer` z `locationFrom` i `locationTo` — przesunięcie jest atomowe.
 * 2. `stkmoveno` wchodzi w deterministyczny `referenceId`, z którego WMS buduje
 *    `idempotency_key` pilnowany unikalnym indeksem. Powtórzony import odbija
 *    się od bazy, a nie od naszej pamięci.
 * 3. Masy jadą w kilogramach, bo w takich jednostkach prowadzony jest magazyn;
 *    megagramy są przeliczane na ekranach i w raportach.
 */

export type MovementOutcome = {
  externalId: string
  action: 'create' | 'skip' | 'failed'
  error?: string
  /** Numer ruchu legacy, do przesunięcia kursora. */
  stkmoveno: number
}

export type MovementContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  warehouseId: string
  locations: Map<string, WarehouseLocation>
  fractions: FractionIndex
  performedBy: string
  /**
   * `orderno` → identyfikator zamówienia sprzedaży w Mercato.
   *
   * Pozwala wydaniu wskazać dokument, który je zleca. Pusty indeks jest
   * poprawny: import ruchów wolno puścić bez modułu sprzedaży, wtedy korekta
   * zostaje samą korektą, tak jak było wcześniej.
   */
  salesOrders?: Map<number, string>
}

/** Para wierszy SORT: zejście z placu i przyjęcie na boks. */
type SortPair = { out: LegacyMovementRow; in: LegacyMovementRow }

/**
 * Składa wiersze SORT w pary. Kluczem jest frakcja, czas i wartość bezwzględna
 * ilości — dokładnie to, co w legacy „wiąże" oba wiersze nieformalnie.
 * Wiersz bez pary zostaje zgłoszony jako błąd pozycji, nie wywraca importu.
 */
export function pairSortRows(rows: LegacyMovementRow[]): { pairs: SortPair[]; orphans: LegacyMovementRow[] } {
  const pending = new Map<string, LegacyMovementRow[]>()
  const pairs: SortPair[] = []
  const orphans: LegacyMovementRow[] = []

  const keyOf = (row: LegacyMovementRow) => `${row.stockid}|${row.data}|${Math.abs(row.iloscKg).toFixed(2)}`

  for (const row of rows) {
    const key = keyOf(row)
    const bucket = pending.get(key) ?? []
    const counterpartIndex = bucket.findIndex((candidate) =>
      row.iloscKg < 0 ? candidate.iloscKg > 0 : candidate.iloscKg < 0,
    )
    if (counterpartIndex === -1) {
      bucket.push(row)
      pending.set(key, bucket)
      continue
    }
    const [counterpart] = bucket.splice(counterpartIndex, 1)
    pending.set(key, bucket)
    pairs.push(
      row.iloscKg < 0 ? { out: row, in: counterpart } : { out: counterpart, in: row },
    )
  }

  for (const bucket of pending.values()) orphans.push(...bucket)
  return { pairs, orphans }
}

/**
 * Czy ten ruch już siedzi w księdze WMS.
 *
 * Klucz idempotencji liczymy tak samo jak WMS, więc powtórzony import nie
 * wysyła komendy w ogóle — a licznik po przebiegu mówi prawdę zamiast meldować
 * „zapisano" o czymś, co system po cichu uznał za powtórkę.
 */
async function alreadyApplied(
  ctx: MovementContext,
  input: Parameters<typeof buildMovementIdempotencyKey>[0],
): Promise<boolean> {
  const idempotencyKey = buildMovementIdempotencyKey(input)
  const existing = await ctx.em.findOne(InventoryMovement, {
    idempotencyKey,
    organizationId: ctx.scope.organizationId,
    tenantId: ctx.scope.tenantId,
  })
  return existing !== null
}

function parseMoment(value: string): Date {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

async function applyReceipt(ctx: MovementContext, row: LegacyMovementRow): Promise<boolean> {
  const location = ctx.locations.get(row.loccode.toUpperCase())
  const fraction = ctx.fractions.get(row.stockid)
  if (!location) throw new Error(`Nieznana lokalizacja legacy: ${row.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${row.stockid}`)

  const performedAt = parseMoment(row.data)
  const referenceId = legacyUuid('movement', row.stkmoveno)
  if (
    await alreadyApplied(ctx, {
      referenceType: 'po',
      referenceId,
      type: 'receipt',
      warehouseId: ctx.warehouseId,
      locationToId: location.id,
      catalogVariantId: fraction.variantId,
      quantity: Math.abs(row.iloscKg),
    })
  ) {
    return true
  }

  await ctx.commandBus.execute('wms.inventory.receive', {
    input: {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      warehouseId: ctx.warehouseId,
      locationId: location.id,
      catalogVariantId: fraction.variantId,
      quantity: Math.abs(row.iloscKg),
      referenceType: 'po',
      referenceId,
      performedBy: ctx.performedBy,
      performedAt,
      receivedAt: performedAt,
      reason: `Przyjęcie odpadu z systemu legacy (PZ ${row.stkmoveno}${row.debtorno ? `, dostawca ${row.debtorno}` : ''})`,
      metadata: { legacy: { stkmoveno: row.stkmoveno, typ: row.typ, debtorno: row.debtorno || null } },
    },
    ctx: ctx.commandContext,
  })
  return false
}

async function applyTransfer(ctx: MovementContext, pair: SortPair): Promise<boolean> {
  const from = ctx.locations.get(pair.out.loccode.toUpperCase())
  const to = ctx.locations.get(pair.in.loccode.toUpperCase())
  const fraction = ctx.fractions.get(pair.in.stockid)
  if (!from || !to) throw new Error(`Nieznana lokalizacja w parze SORT: ${pair.out.loccode} → ${pair.in.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${pair.in.stockid}`)

  const referenceId = legacyUuid('movement', pair.in.stkmoveno)
  if (
    await alreadyApplied(ctx, {
      referenceType: 'transfer',
      referenceId,
      type: 'transfer',
      warehouseId: ctx.warehouseId,
      locationFromId: from.id,
      locationToId: to.id,
      catalogVariantId: fraction.variantId,
      quantity: Math.abs(pair.in.iloscKg),
    })
  ) {
    return true
  }

  await ctx.commandBus.execute('wms.inventory.move', {
    input: {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      warehouseId: ctx.warehouseId,
      fromLocationId: from.id,
      toLocationId: to.id,
      catalogVariantId: fraction.variantId,
      quantity: Math.abs(pair.in.iloscKg),
      type: 'transfer',
      reason: `Wysortowanie frakcji (SORT ${pair.out.stkmoveno}/${pair.in.stkmoveno})`,
      reasonCode: 'SORT',
      referenceType: 'transfer',
      referenceId,
      performedBy: ctx.performedBy,
      performedAt: parseMoment(pair.in.data),
      metadata: {
        legacy: { stkmoveno: [pair.out.stkmoveno, pair.in.stkmoveno], typ: 'SORT' },
      },
    },
    ctx: ctx.commandContext,
  })
  return false
}

async function applyIssue(ctx: MovementContext, row: LegacyMovementRow): Promise<boolean> {
  const location = ctx.locations.get(row.loccode.toUpperCase())
  const fraction = ctx.fractions.get(row.stockid)
  if (!location) throw new Error(`Nieznana lokalizacja legacy: ${row.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${row.stockid}`)

  const referenceId = legacyUuid('movement', row.stkmoveno)
  if (
    await alreadyApplied(ctx, {
      referenceType: 'so',
      referenceId,
      type: 'adjust',
      warehouseId: ctx.warehouseId,
      // Korekta zapisuje lokalizację jako `locationTo`, nawet gdy zdejmuje stan
      // — klucz musi to odwzorować, inaczej powtórka wygląda na nowy ruch.
      locationToId: location.id,
      catalogVariantId: fraction.variantId,
      quantity: -Math.abs(row.iloscKg),
    })
  ) {
    return true
  }

  await ctx.commandBus.execute('wms.inventory.adjust', {
    input: {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      warehouseId: ctx.warehouseId,
      locationId: location.id,
      catalogVariantId: fraction.variantId,
      delta: -Math.abs(row.iloscKg),
      reason: `Wydanie do odbiorcy ${row.debtorno || 'nieznany'} (WZ ${row.stkmoveno})`,
      reasonCode: 'WZ',
      referenceType: 'so',
      referenceId,
      performedBy: ctx.performedBy,
      performedAt: parseMoment(row.data),
      metadata: {
        legacy: {
          stkmoveno: row.stkmoveno,
          typ: row.typ,
          debtorno: row.debtorno || null,
          orderno: row.orderno || null,
        },
        // Identyfikator dokumentu sprzedaży, który to wydanie realizuje.
        // `referenceId` jest zajęty przez klucz idempotencji liczony ze
        // `stkmoveno`, więc powiązanie z zamówieniem idzie metadanymi.
        salesOrderId: salesOrderIdFor(ctx, row) ?? null,
      },
    },
    ctx: ctx.commandContext,
  })
  return false
}

/** Zamówienie, które realizuje to wydanie — o ile import objął sprzedaż. */
function salesOrderIdFor(ctx: MovementContext, row: LegacyMovementRow): string | undefined {
  if (!row.orderno) return undefined
  return ctx.salesOrders?.get(row.orderno)
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /idempot|duplicate key|unique/i.test(message)
}

/**
 * Wykonuje partię ruchów. Duplikat jest wynikiem poprawnym: import wolno
 * puścić dwa razy, a księga ma zostać ta sama.
 */
export async function applyMovementBatch(
  ctx: MovementContext,
  rows: LegacyMovementRow[],
  options: { carry?: LegacyMovementRow[]; final?: boolean } = {},
): Promise<{ outcomes: MovementOutcome[]; carry: LegacyMovementRow[] }> {
  const outcomes: MovementOutcome[] = []
  // Para SORT potrafi rozpasc sie na granicy partii: drugi wiersz wpada do
  // nastepnej porcji. Niesparowane wiersze jada dalej zamiast byc bledem.
  const sortRows = [...(options.carry ?? []), ...rows.filter((row) => row.typ === 'SORT')]
  const { pairs, orphans } = pairSortRows(sortRows)

  for (const row of rows.filter((item) => item.typ === 'PZ')) {
    try {
      const replay = await applyReceipt(ctx, row)
      outcomes.push({ externalId: String(row.stkmoveno), action: replay ? 'skip' : 'create', stkmoveno: row.stkmoveno })
    } catch (error) {
      outcomes.push({
        externalId: String(row.stkmoveno),
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: row.stkmoveno,
      })
    }
  }

  for (const pair of pairs) {
    const externalId = `${pair.out.stkmoveno}+${pair.in.stkmoveno}`
    try {
      const replay = await applyTransfer(ctx, pair)
      outcomes.push({ externalId, action: replay ? 'skip' : 'create', stkmoveno: Math.max(pair.out.stkmoveno, pair.in.stkmoveno) })
    } catch (error) {
      outcomes.push({
        externalId,
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: Math.max(pair.out.stkmoveno, pair.in.stkmoveno),
      })
    }
  }

  for (const row of rows.filter((item) => item.typ === 'WZ')) {
    try {
      const replay = await applyIssue(ctx, row)
      outcomes.push({ externalId: String(row.stkmoveno), action: replay ? 'skip' : 'create', stkmoveno: row.stkmoveno })
    } catch (error) {
      outcomes.push({
        externalId: String(row.stkmoveno),
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: row.stkmoveno,
      })
    }
  }

  if (options.final) {
    for (const orphan of orphans) {
      outcomes.push({
        externalId: String(orphan.stkmoveno),
        action: 'failed',
        error: 'Wiersz SORT bez pary — para rozjechała się w eksporcie legacy.',
        stkmoveno: orphan.stkmoveno,
      })
    }
  }

  return {
    outcomes: outcomes.sort((a, b) => a.stkmoveno - b.stkmoveno),
    carry: options.final ? [] : orphans,
  }
}
