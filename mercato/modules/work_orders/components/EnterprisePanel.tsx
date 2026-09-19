'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'

/**
 * Panel przedsiębiorstwa.
 *
 * Kolejność kolumn nie jest przypadkowa i oddaje, czyje to jest pytanie.
 * Najpierw zlecenie i odbiorca — bo kierownik zakładu zaczyna od „na czyją
 * rzecz". Potem postęp w kilogramach. Rozjazd jest na końcu, ale to on jest
 * jedyną liczbą na tym ekranie, której nie da się zobaczyć w żadnym innym
 * systemie: **ile materiału robot zgłosił jako przeniesiony, a nie przeniósł.**
 */

type Order = {
  id: string
  orderNumber: string
  sku: string
  cell: string | null
  policy: string | null
  salesOrderNumber: string | null
  status: string
  targetKg: number
  producedKg: number
  progressRatio: number | null
  batches: number
  openBatch: string | null
  driftKg: number | null
  driftRatio: number | null
  overclaimBatches: number
}

type Payload = {
  generatedAt: string
  totals: {
    ordersOpen: number
    producedKg: number
    driftKg: number
    ordersWithoutReference: number
    overclaimBatches: number
  }
  orders: Order[]
}

const STATUS_LABEL: Record<string, string> = {
  open: 'W toku',
  completed: 'Zamknięte',
  cancelled: 'Anulowane',
}

function kg(value: number): string {
  return `${value.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`
}

/**
 * Opis rozjazdu.
 *
 * `null` znaczy „nie mamy masy nominalnej sztuki", a nie „zero". Te dwie
 * rzeczy nie mogą wyglądać tak samo: pierwsza to brak pomiaru, druga to
 * pomiar wynoszący zero.
 */
function describeDrift(order: Order): { text: string; tone: string } {
  if (order.driftKg === null) return { text: 'brak odniesienia', tone: 'text-muted-foreground' }
  const procent = order.driftRatio === null ? '' : ` (${(order.driftRatio * 100).toFixed(1)}%)`
  if (order.overclaimBatches > 0) {
    return { text: `${kg(order.driftKg)}${procent}`, tone: 'text-red-600' }
  }
  if (order.driftKg > 0) return { text: `+${kg(order.driftKg)}${procent}`, tone: 'text-amber-600' }
  return { text: `${kg(order.driftKg)}${procent}`, tone: 'text-muted-foreground' }
}

export default function EnterprisePanel() {
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/work_orders/panel')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? `Błąd ${response.status}`)
        return
      }
      setData((await response.json()) as Payload)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const totals = data?.totals
  const orders = data?.orders ?? []

  return (
    <div className="flex flex-col gap-6" data-testid="enterprise-panel">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Zlecenia w toku"
          value={totals?.ordersOpen ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">cele pracujące na zamówienia</span>}
        />
        <KpiCard
          title="Wyprodukowano"
          value={totals ? Number(totals.producedKg.toFixed(1)) : null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">kilogramów z wagi, nie z deklaracji</span>}
        />
        <KpiCard
          title="Rozjazd"
          value={totals ? Number(totals.driftKg.toFixed(1)) : null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.ordersWithoutReference
                ? `${totals.ordersWithoutReference} zleceń bez masy nominalnej`
                : 'kg wagi minus deklaracja robota'}
            </span>
          }
        />
        <KpiCard
          title="Brakujący materiał"
          value={totals?.overclaimBatches ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              partii, w których robot zgłosił więcej, niż przyniósł
            </span>
          }
        />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">Zlecenia robocze</span>
          <span className="text-xs text-muted-foreground">
            {data ? `stan na ${new Date(data.generatedAt).toLocaleTimeString('pl-PL')}` : ''}
          </span>
        </div>

        {orders.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Brak zleceń roboczych. Załóż je komendą{' '}
            <code className="rounded bg-muted px-1">mercato work_orders prove</code>.
          </div>
        ) : (
          <div className="divide-y">
            {orders.map((order) => {
              const drift = describeDrift(order)
              return (
                <div key={order.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{order.orderNumber}</span>
                      <span className="font-mono text-xs text-muted-foreground">{order.sku}</span>
                      {order.salesOrderNumber ? (
                        <span
                          className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                          title="Zamówienie sprzedaży, na którego rzecz powstało zlecenie"
                        >
                          {order.salesOrderNumber}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[order.cell, order.policy].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  <div className="w-40">
                    <div className="text-sm">
                      {kg(order.producedKg)}
                      <span className="text-xs text-muted-foreground"> / {kg(order.targetKg)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {order.progressRatio === null ? '—' : `${(order.progressRatio * 100).toFixed(0)}%`}
                      {' · '}
                      {order.batches} partii
                      {order.openBatch ? ` · ${order.openBatch} w toku` : ''}
                    </div>
                  </div>

                  <div className="w-52 text-right">
                    <div className={`text-sm ${drift.tone}`}>{drift.text}</div>
                    <div className="text-xs text-muted-foreground">
                      {STATUS_LABEL[order.status] ?? order.status}
                      {order.overclaimBatches > 0 ? ` · ${order.overclaimBatches} do sprawdzenia` : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
