'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'

/**
 * Rejestr floty na ekranie.
 *
 * Pierwsza wartość, jaką ta platforma dostarcza, nie jest wyrafinowana:
 * **ile robotów rejestr twierdzi, że istnieje, a ile stoi w hali**. Ta liczba
 * się nie zgadza w każdym wdrożeniu — dlatego ekran zaczyna się od stanu
 * liczbowego, a nie od wykresu.
 */

type Robot = {
  id: string
  serialNumber: string
  name: string
  state: string
  stateReason: string | null
  stateChangedAt: string | null
  embodiment: string | null
  cell: string | null
  site: string | null
  riskClass: string | null
  externallyOperated: boolean
  calibrationState: 'valid' | 'expiring' | 'blocked' | 'unknown'
  calibrationDaysLeft: number | null
}

type Payload = {
  generatedAt: string
  totals: {
    robots: number
    active: number
    quarantined: number
    calibrationBlocked: number
    calibrationExpiring: number
    externallyOperated: number
  }
  byState: Record<string, number>
  robots: Robot[]
}

const STATE_LABEL: Record<string, string> = {
  registered: 'Zarejestrowany',
  commissioning: 'Uruchamianie',
  ready: 'Gotowy',
  operational: 'W ruchu',
  maintenance: 'Serwis',
  quarantined: 'Kwarantanna',
  decommissioning: 'Wycofywanie',
  decommissioned: 'Wycofany',
}

/** Kolor niesie pilność, nie kategorię: czerwony znaczy „ta maszyna nie pracuje". */
const STATE_TONE: Record<string, string> = {
  operational: 'text-emerald-600',
  ready: 'text-emerald-600',
  quarantined: 'text-red-600',
  maintenance: 'text-amber-600',
  decommissioned: 'text-muted-foreground',
}

function formatMoment(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function describeCalibration(robot: Robot): { text: string; tone: string } {
  if (robot.calibrationState === 'blocked') {
    return { text: 'kalibracja nieważna', tone: 'text-red-600' }
  }
  if (robot.calibrationState === 'expiring') {
    return { text: `kalibracja wygasa za ${robot.calibrationDaysLeft} dni`, tone: 'text-amber-600' }
  }
  if (robot.calibrationState === 'valid') {
    return { text: `kalibracja ważna ${robot.calibrationDaysLeft} dni`, tone: 'text-muted-foreground' }
  }
  return { text: 'brak wymagań kalibracyjnych', tone: 'text-muted-foreground' }
}

export default function FleetRegistry() {
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/fleet/robots')
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
  const robots = data?.robots ?? []

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Roboty w rejestrze"
          value={totals?.robots ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.externallyOperated
                ? `${totals.externallyOperated} obsługiwanych przez integratora`
                : 'wszystkie obsługiwane własnymi siłami'}
            </span>
          }
        />
        <KpiCard
          title="Czynne"
          value={totals?.active ?? null}
          loading={loading}
          footer={<span className="text-xs text-muted-foreground">gotowe lub w ruchu</span>}
        />
        <KpiCard
          title="W kwarantannie"
          value={totals?.quarantined ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              niedopuszczone — bywają mechanicznie sprawne
            </span>
          }
        />
        <KpiCard
          title="Blokada kalibracji"
          value={totals?.calibrationBlocked ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {totals?.calibrationExpiring
                ? `${totals.calibrationExpiring} wygasa w ciągu 14 dni`
                : 'nic nie wygasa w ciągu 14 dni'}
            </span>
          }
        />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">Rejestr floty</span>
          <span className="text-xs text-muted-foreground">
            {data ? `stan na ${formatMoment(data.generatedAt)}` : ''}
          </span>
        </div>

        {robots.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Rejestr jest pusty. Zaimportuj flotę komendą{' '}
            <code className="rounded bg-muted px-1">mercato fleet seed</code>.
          </div>
        ) : (
          <div className="divide-y">
            {robots.map((robot) => {
              const calibration = describeCalibration(robot)
              return (
                <div key={robot.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{robot.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{robot.serialNumber}</span>
                      {robot.externallyOperated ? (
                        <span
                          className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                          title="Właściciel i operator to różne podmioty"
                        >
                          integrator
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[robot.embodiment, robot.site, robot.cell].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  <div className="w-44">
                    <div className={`text-sm ${STATE_TONE[robot.state] ?? ''}`}>
                      {STATE_LABEL[robot.state] ?? robot.state}
                    </div>
                    {/* Powód jest tu, a nie w szczegółach: przy kwarantannie to
                        jedyna rzecz odróżniająca wygasłą kalibrację od incydentu. */}
                    <div className="truncate text-xs text-muted-foreground" title={robot.stateReason ?? ''}>
                      {robot.stateReason ?? '—'}
                    </div>
                  </div>

                  <div className="w-56 text-right">
                    <div className={`text-xs ${calibration.tone}`}>{calibration.text}</div>
                    <div className="text-xs text-muted-foreground">
                      od {formatMoment(robot.stateChangedAt)}
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
