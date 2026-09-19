import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Dane pulpitu sortowni.
 *
 * Wszystko liczymy z encji WMS, a nie z osobnej tabeli raportowej: pulpit ma
 * pokazywać ten sam stan, który widzi magazyn, a nie jego kopię sprzed godziny.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sortownia.view'] },
}

type LocationRow = {
  code: string
  type: string
  capacityKg: number | null
  quantityKg: number | null
  utilisation: number | null
  legacyName: string | null
}

type FractionRow = {
  sku: string
  name: string
  quantityKg: number
  reorderPointKg: number | null
  belowReorderPoint: boolean
}

type MovementRow = {
  id: string
  type: string
  performedAt: string
  quantityKg: number
  fractionSku: string | null
  fractionName: string | null
  fromCode: string | null
  toCode: string | null
  reason: string | null
  legacyMoveNo: number | string | null
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

export async function GET(): Promise<Response> {
  const auth = await getAuthFromCookies()
  if (!auth) return unauthorized()

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    // Super-admin oglądający „wszystkie organizacje" nie ma wybranego zakresu;
    // 400 zamiast 401, żeby klient nie wpadł w pętlę odświeżania sesji.
    return new Response(JSON.stringify({ error: 'organization_scope_required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const scope = { organizationId, tenantId: auth.tenantId as string }

  const locations = await em.getConnection().execute<Array<{
    code: string
    type: string
    capacity_weight: string | null
    metadata: Record<string, unknown> | null
    quantity: string | null
  }>>(
    `select l.code,
            l.type,
            l.capacity_weight,
            l.metadata,
            coalesce(sum(b.quantity_on_hand), 0) as quantity
       from wms_warehouse_locations l
       left join wms_inventory_balances b
              on b.location_id = l.id
             and b.deleted_at is null
      where l.organization_id = ?
        and l.tenant_id = ?
        and l.deleted_at is null
      group by l.id, l.code, l.type, l.capacity_weight, l.metadata
      order by l.code`,
    [scope.organizationId, scope.tenantId],
  )

  const locationRows: LocationRow[] = locations.map((row) => {
    const capacityKg = row.capacity_weight === null ? null : Number.parseFloat(row.capacity_weight)
    const quantityKg = row.quantity === null ? 0 : Number.parseFloat(row.quantity)
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    return {
      code: row.code,
      type: row.type,
      capacityKg,
      quantityKg,
      utilisation: capacityKg && capacityKg > 0 ? Math.round((quantityKg / capacityKg) * 1000) / 10 : null,
      legacyName: typeof metadata.legacyName === 'string' ? metadata.legacyName : null,
    }
  })

  const fractions = await em.getConnection().execute<Array<{
    sku: string
    name: string | null
    quantity: string | null
    reorder_point: string | null
  }>>(
    `select v.sku,
            coalesce(v.name, p.title) as name,
            coalesce(sum(b.quantity_on_hand), 0) as quantity,
            max(pr.reorder_point) as reorder_point
       from catalog_product_variants v
       join catalog_products p on p.id = v.product_id
       left join wms_inventory_balances b
              on b.catalog_variant_id = v.id
             and b.deleted_at is null
       left join wms_product_inventory_profiles pr
              on pr.catalog_variant_id = v.id
             and pr.deleted_at is null
      where v.organization_id = ?
        and v.tenant_id = ?
        and v.deleted_at is null
        and v.sku is not null
        -- Katalog Mercato trzyma też produkty spoza sortowni (demo, usługi).
        -- Frakcją jest tylko pozycja, którą przyniósł import z systemu legacy.
        and exists (
          select 1
            from wms_product_inventory_profiles pl
           where pl.catalog_variant_id = v.id
             and pl.deleted_at is null
             and pl.metadata->>'legacyStockid' is not null
        )
      group by v.sku, v.name, p.title
      order by quantity desc`,
    [scope.organizationId, scope.tenantId],
  )

  const fractionRows: FractionRow[] = fractions.map((row) => {
    const quantityKg = row.quantity === null ? 0 : Number.parseFloat(row.quantity)
    const reorderPointKg = row.reorder_point === null ? null : Number.parseFloat(row.reorder_point)
    return {
      sku: row.sku,
      name: row.name ?? row.sku,
      quantityKg,
      reorderPointKg,
      belowReorderPoint: reorderPointKg !== null && quantityKg < reorderPointKg,
    }
  })

  const movements = await em.getConnection().execute<Array<{
    id: string
    type: string
    performed_at: string
    quantity: string
    reason: string | null
    metadata: Record<string, unknown> | null
    sku: string | null
    variant_name: string | null
    from_code: string | null
    to_code: string | null
  }>>(
    `select m.id,
            m.type,
            m.performed_at,
            m.quantity,
            m.reason,
            m.metadata,
            v.sku,
            v.name as variant_name,
            lf.code as from_code,
            lt.code as to_code
       from wms_inventory_movements m
       left join catalog_product_variants v on v.id = m.catalog_variant_id
       left join wms_warehouse_locations lf on lf.id = m.location_from_id
       left join wms_warehouse_locations lt on lt.id = m.location_to_id
      where m.organization_id = ?
        and m.tenant_id = ?
        and m.deleted_at is null
      order by m.performed_at desc, m.created_at desc
      limit 20`,
    [scope.organizationId, scope.tenantId],
  )

  const movementRows: MovementRow[] = movements.map((row) => {
    const metadata = (row.metadata ?? {}) as { legacy?: { stkmoveno?: number | number[] } }
    const legacy = metadata.legacy?.stkmoveno
    return {
      id: row.id,
      type: row.type,
      performedAt: new Date(row.performed_at).toISOString(),
      quantityKg: Number.parseFloat(row.quantity),
      fractionSku: row.sku,
      fractionName: row.variant_name,
      fromCode: row.from_code,
      toCode: row.to_code,
      reason: row.reason,
      legacyMoveNo: Array.isArray(legacy) ? legacy.join(' + ') : (legacy ?? null),
    }
  })

  const flowByFraction = await em.getConnection().execute<Array<{
    sku: string
    received: string
    sorted: string
    issued: string
  }>>(
    `select v.sku,
            coalesce(sum(case when m.type = 'receipt' then m.quantity else 0 end), 0) as received,
            coalesce(sum(case when m.type = 'transfer' then m.quantity else 0 end), 0) as sorted,
            coalesce(sum(case when m.type = 'adjust' then abs(m.quantity) else 0 end), 0) as issued
       from wms_inventory_movements m
       join catalog_product_variants v on v.id = m.catalog_variant_id
      where m.organization_id = ?
        and m.tenant_id = ?
        and m.deleted_at is null
        and m.performed_at >= now() - interval '30 days'
      group by v.sku
      order by received desc`,
    [scope.organizationId, scope.tenantId],
  )

  const [flow] = await em.getConnection().execute<Array<{
    receipts: string
    issues: string
    transfers: string
    total: string
    last_performed_at: string | null
  }>>(
    `select coalesce(sum(case when type = 'receipt' then quantity else 0 end), 0) as receipts,
            coalesce(sum(case when type = 'adjust' then abs(quantity) else 0 end), 0) as issues,
            coalesce(sum(case when type = 'transfer' then quantity else 0 end), 0) as transfers,
            count(*) as total,
            max(performed_at) as last_performed_at
       from wms_inventory_movements
      where organization_id = ?
        and tenant_id = ?
        and deleted_at is null
        and performed_at >= now() - interval '30 days'`,
    [scope.organizationId, scope.tenantId],
  )

  const yardKg = locationRows
    .filter((row) => row.type === 'staging')
    .reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)
  const binsKg = locationRows
    .filter((row) => row.type !== 'staging')
    .reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: {
        yardKg,
        binsKg,
        receipts30dKg: Number.parseFloat(flow?.receipts ?? '0'),
        issues30dKg: Number.parseFloat(flow?.issues ?? '0'),
        sorted30dKg: Number.parseFloat(flow?.transfers ?? '0'),
        movements30d: Number.parseInt(flow?.total ?? '0', 10),
        lastMovementAt: flow?.last_performed_at ? new Date(flow.last_performed_at).toISOString() : null,
      },
      locations: locationRows,
      fractions: fractionRows,
      flow: flowByFraction.map((row) => ({
        sku: row.sku,
        receivedKg: Number.parseFloat(row.received),
        sortedKg: Number.parseFloat(row.sorted),
        issuedKg: Number.parseFloat(row.issued),
      })),
      movements: movementRows,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
