'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'

/**
 * Kadencja autonomii na ekranie.
 *
 * Liczbą wiodącą jest **epizody na interwencję**, a nie skuteczność. Skuteczność
 * rośnie od pierwszego dnia i przestaje coś znaczyć w drugim tygodniu; liczba
 * epizodów między przerwaniami rośnie albo nie rośnie, i to widać.
 *
 * Drugą rzeczą wyciągniętą na wierzch jest rozkład interwencji po **etapie**.
 * To jedyna tabela na tym ekranie, która mówi, co zrobić dalej: etap, na którym
 * ludzie przerywają najczęściej, jest tym, z którego trzeba zebrać demonstracje
 * korekcyjne do następnego treningu.
 */

type Cadence = {
  episodes: number
  interventions: number
  intervenedEpisodes: number
  cleanEpisodes: number
  successes: number
  meanEpisodesBetweenInterventions: number | null
  currentStreak: number
  longestStreak: number
  streaks: number[]
  autonomyRate: number
  successRate: number
}

type Payload = {
  generatedAt: string
  ledger: { episodes: number; interventions: number }
  consistency: { consistent: boolean; problems: string[] }
  overall: Cadence
  byPolicy: Record<string, Cadence>
  byCell: Record<string, Cadence>
  byRobot: Record<string, Cadence>
  interventionsByKind: Record<string, number>
  interventionsByStage: Record<string, number>
}

const KIND_LABEL: Record<string, string> = {
  adjust: 'poprawka otoczenia',
  manual_reset: 'odblokowanie ręczne',
  teleop_takeover: 'przejęcie sterowania',
  abort: 'przerwanie zadania',
  estop: 'zatrzymanie awaryjne',
}

/** Kolor rośnie z ciężarem przerwania — to nie kategoria, to pilność. */
const KIND_TONE: Record<string, string> = {
  adjust: 'text-muted-foreground',
  manual_reset: 'text-muted-foreground',
  teleop_takeover: 'text-amber-600',
  abort: 'text-amber-600',
  estop: 'text-red-600',
}

function formatMean(value: number | null): string {
  // `null` znaczy „nie było interwencji" i to NIE jest to samo, co liczba bardzo
  // duża. Brak interwencji w serii pięciu epizodów nie jest dowodem autonomii.
  return value === null ? 'brak interwencji' : value.toFixed(1)
}

function CadenceTable({ title, data, note }: { title: string; data: Record<string, Cadence>; note: string }) {
  const rows = Object.entries(data)
  if (!rows.length) return null
  return (
    <div className="rounded-md border">
      <div className="border-b px-4 py-3">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-normal">klucz</th>
            <th className="px-4 py-2 font-normal">epizody</th>
            <th className="px-4 py-2 font-normal">interwencje</th>
            <th className="px-4 py-2 font-normal">epizodów na interwencję</th>
            <th className="px-4 py-2 font-normal">bieżąca seria</th>
            <th className="px-4 py-2 font-normal">najdłuższa</th>
            <th className="px-4 py-2 font-normal">skuteczność</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="border-t">
              <td className="px-4 py-2">{key}</td>
              <td className="px-4 py-2">{value.episodes}</td>
              <td className="px-4 py-2">{value.interventions}</td>
              <td className="px-4 py-2 font-medium">
                {formatMean(value.meanEpisodesBetweenInterventions)}
              </td>
              <td className="px-4 py-2">{value.currentStreak}</td>
              <td className="px-4 py-2 text-muted-foreground">{value.longestStreak}</td>
              <td className="px-4 py-2 text-muted-foreground">
                {(value.successRate * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CadenceBoard() {
  const [data, setData] = React.useState<Payload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/episodes/cadence')
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
  }, [load])

  const overall = data?.overall
  const stages = Object.entries(data?.interventionsByStage ?? {})
  const kinds = Object.entries(data?.interventionsByKind ?? {})

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      {data && !data.consistency.consistent ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
          <div className="font-medium">Raport rozjechał się z księgą epizodów</div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {data.consistency.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <div className="mt-1 text-xs">
            Uruchom <code>yarn mercato episodes reconcile</code>. Do tego czasu liczbom poniżej nie wierz.
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Epizodów na interwencję"
          value={overall?.meanEpisodesBetweenInterventions ?? null}
          loading={loading}
          formatValue={(value) => value.toFixed(1)}
          footer={
            <span className="text-xs text-muted-foreground">
              {overall && overall.meanEpisodesBetweenInterventions === null
                ? 'nie było jeszcze ani jednej interwencji — to brak danych, nie autonomia'
                : 'jedyna liczba, która mówi, czy wdrożenie idzie do przodu'}
            </span>
          }
        />
        <KpiCard
          title="Bieżąca seria bez człowieka"
          value={overall?.currentStreak ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              najdłuższa dotąd: {overall?.longestStreak ?? '—'}
            </span>
          }
        />
        <KpiCard
          title="Epizody w księdze"
          value={overall?.episodes ?? null}
          loading={loading}
          footer={
            <span className="text-xs text-muted-foreground">
              {overall ? `${overall.interventions} interwencji` : '—'}
            </span>
          }
        />
        <KpiCard
          title="Autonomia"
          value={overall ? overall.autonomyRate * 100 : null}
          loading={loading}
          formatValue={(value) => `${value.toFixed(0)}%`}
          footer={
            <span className="text-xs text-muted-foreground">
              epizodów bez udziału człowieka; skuteczność {overall ? `${(overall.successRate * 100).toFixed(0)}%` : '—'}
            </span>
          }
        />
      </div>

      {!loading && !overall?.episodes ? (
        <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">
          Księga epizodów jest pusta. Uruchom <code>yarn mercato episodes simulate</code>.
        </div>
      ) : null}

      <CadenceTable
        title="Per polityka"
        data={data?.byPolicy ?? {}}
        note="ta sama polityka na różnym sprzęcie bywa różną polityką — porównuj wersje, nie nazwy"
      />
      <CadenceTable
        title="Per cela"
        data={data?.byCell ?? {}}
        note="różnica między celami tej samej klasy to zwykle oświetlenie albo ustawienie pojemnika"
      />
      <CadenceTable
        title="Per robot"
        data={data?.byRobot ?? {}}
        note="jeden robot odstający od reszty to prawie zawsze kalibracja, a nie polityka"
      />

      {stages.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border">
            <div className="border-b px-4 py-3">
              <div className="font-medium">Interwencje po etapie</div>
              <div className="text-xs text-muted-foreground">
                stąd bierze się lista demonstracji do następnego treningu
              </div>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {stages.map(([stage, count]) => (
                  <tr key={stage} className="border-t">
                    <td className="px-4 py-2">{stage}</td>
                    <td className="px-4 py-2 text-right">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border">
            <div className="border-b px-4 py-3">
              <div className="font-medium">Interwencje po ciężarze</div>
              <div className="text-xs text-muted-foreground">
                same poprawki otoczenia i same zatrzymania awaryjne to dwa różne wdrożenia
              </div>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {kinds.map(([kind, count]) => (
                  <tr key={kind} className="border-t">
                    <td className={`px-4 py-2 ${KIND_TONE[kind] ?? ''}`}>{KIND_LABEL[kind] ?? kind}</td>
                    <td className="px-4 py-2 text-right">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
