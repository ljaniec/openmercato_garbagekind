'use client'

import * as React from 'react'
import { apiFetch } from '@open-mercato/ui/backend/utils/api'
import { arrangeInCell, boundsOf, fitTransform, toPixels, type Transform } from '../lib/layout'

/**
 * Rzut hali: gdzie co stoi, w jakim jest stanie i co z tego wyszło.
 *
 * Ekran składa cztery źródła, z których **trzy są opcjonalne**: rejestr floty
 * (geometria i stan maszyn), łączność agentów, wynik produkcyjny i zliczenia
 * wizji. Brak któregokolwiek z trzech ostatnich odejmuje warstwę informacji,
 * a nie wywraca rzutu — na świeżej instalacji z samym `fleet` rysunek działa.
 *
 * Czego ten rysunek **nie** robi: nie rozstawia cel bez obmiaru. Trafiają na
 * listę obok, bo plan hali czyta się po to, żeby wiedzieć, gdzie iść, a
 * zmyślona pozycja jest gorsza niż jej brak.
 */

type Cell = {
  id: string
  siteId: string
  code: string
  name: string
  cellClass: string
  riskClass: string
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  rotationDeg: number | null
  robotCount: number
}

type Robot = {
  id: string
  cellId: string | null
  serialNumber: string
  name: string
  state: string
  stateReason: string | null
  embodiment: string | null
  externallyOperated: boolean
  calibrationState: 'valid' | 'expiring' | 'blocked' | 'unknown'
  calibrationDaysLeft: number | null
}

type Site = { id: string; code: string; name: string; floorWidthM: number | null; floorHeightM: number | null }

type LayoutPayload = {
  generatedAt: string
  sites: Site[]
  cells: Cell[]
  unplacedCells: Cell[]
  unassignedRobots: number
  robots: Robot[]
}

type AgentLink = { robotId: string; state: string; status: string; silenceSeconds: number | null }
type OrderRow = { cellId: string | null; producedKg: number; overclaimBatches: number; status: string }
type VisionBatch = { cellId: string | null; suspect: string }

/** Stan robota → kolor wypełnienia. Czerwony znaczy „ta maszyna nie pracuje". */
const STATE_FILL: Record<string, string> = {
  operational: '#059669',
  ready: '#34d399',
  maintenance: '#d97706',
  quarantined: '#dc2626',
  commissioning: '#0284c7',
  registered: '#94a3b8',
  decommissioning: '#64748b',
  decommissioned: '#cbd5e1',
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

/**
 * Klasa ryzyka → obrys celi.
 *
 * Ogrodzona rysuje się linią ciągłą, dzielona i publiczna przerywaną — bo
 * różnica między „tu jest płot" a „tu chodzą ludzie" jest tą jedną rzeczą,
 * którą na planie hali trzeba zobaczyć z drugiego końca pomieszczenia.
 */
const RISK_STROKE: Record<string, { stroke: string; dash?: string; label: string }> = {
  fenced: { stroke: '#64748b', label: 'ogrodzona' },
  shared: { stroke: '#d97706', dash: '6 4', label: 'dzielona z ludźmi' },
  public: { stroke: '#dc2626', dash: '3 3', label: 'przestrzeń publiczna' },
}

const VIEWPORT = { width: 900, height: 520, padding: 28 }

export default function PlantLayout() {
  const [layout, setLayout] = React.useState<LayoutPayload | null>(null)
  const [agents, setAgents] = React.useState<Record<string, AgentLink> | null>(null)
  const [orders, setOrders] = React.useState<OrderRow[] | null>(null)
  const [batches, setBatches] = React.useState<VisionBatch[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch('/api/fleet/layout')
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        setError(body?.error ?? `Błąd ${response.status}`)
        return
      }
      setLayout((await response.json()) as LayoutPayload)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    } finally {
      setLoading(false)
    }

    /*
     * Warstwy opcjonalne. Każda w osobnym `try`, bo brak modułu albo brak
     * uprawnienia do niego nie jest powodem, żeby rzut przestał działać —
     * jest powodem, żeby jedna warstwa się nie narysowała.
     */
    try {
      const r = await apiFetch('/api/edge/agents')
      setAgents(r.ok ? ((await r.json()) as { byRobot: Record<string, AgentLink> }).byRobot : null)
    } catch {
      setAgents(null)
    }
    try {
      const r = await apiFetch('/api/work_orders/panel')
      setOrders(r.ok ? ((await r.json()) as { orders: OrderRow[] }).orders : null)
    } catch {
      setOrders(null)
    }
    try {
      const r = await apiFetch('/api/vision/panel')
      setBatches(r.ok ? ((await r.json()) as { batches: VisionBatch[] }).batches : null)
    } catch {
      setBatches(null)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const cells = layout?.cells ?? []
  const robots = layout?.robots ?? []
  const site = layout?.sites?.[0] ?? null

  /** Obwiednia obejmuje obrys hali, gdy jest podany — inaczej same cele. */
  const bounds = React.useMemo(() => {
    const items = cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height }))
    if (site?.floorWidthM && site?.floorHeightM) {
      items.push({ x: 0, y: 0, width: site.floorWidthM, height: site.floorHeightM })
    }
    return boundsOf(items)
  }, [cells, site])

  const transform: Transform = React.useMemo(() => fitTransform(bounds, VIEWPORT), [bounds])

  /** Wynik produkcyjny i podejrzani, zsumowani per cela. */
  const perCell = React.useMemo(() => {
    const map = new Map<string, { producedKg: number; overclaim: number; visionSuspects: number }>()
    for (const order of orders ?? []) {
      if (!order.cellId) continue
      const current = map.get(order.cellId) ?? { producedKg: 0, overclaim: 0, visionSuspects: 0 }
      current.producedKg += order.producedKg
      current.overclaim += order.overclaimBatches
      map.set(order.cellId, current)
    }
    for (const batch of batches ?? []) {
      if (!batch.cellId) continue
      if (batch.suspect === 'none' || batch.suspect === 'no_reference') continue
      const current = map.get(batch.cellId) ?? { producedKg: 0, overclaim: 0, visionSuspects: 0 }
      current.visionSuspects += 1
      map.set(batch.cellId, current)
    }
    return map
  }, [orders, batches])

  const selectedCell = cells.find((c) => c.id === selected) ?? null
  const selectedRobots = robots.filter((r) => r.cellId === selected)

  return (
    <div className="flex flex-col gap-4" data-testid="plant-layout">
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{error}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{site?.name ?? 'Hala'}</span>
        {site?.floorWidthM && site?.floorHeightM ? (
          <span>{site.floorWidthM} × {site.floorHeightM} m</span>
        ) : (
          <span>obrys hali nieobmierzony</span>
        )}
        <span>{cells.length} cel na rzucie</span>
        <span>{robots.length} robotów</span>
        {agents === null ? <span>łączność: warstwa niedostępna</span> : null}
        {orders === null ? <span>wynik: warstwa niedostępna</span> : null}
        {layout ? <span>stan na {new Date(layout.generatedAt).toLocaleTimeString('pl-PL')}</span> : null}
      </div>

      <div className="rounded-lg border bg-background">
        <svg
          viewBox={`0 0 ${VIEWPORT.width} ${VIEWPORT.height}`}
          className="h-auto w-full"
          role="img"
          aria-label="Rzut hali z rozmieszczeniem cel i robotów"
        >
          {/* Obrys hali — rysowany tylko, gdy ktoś ją zmierzył. */}
          {site?.floorWidthM && site?.floorHeightM
            ? (() => {
                const a = toPixels({ x: 0, y: 0 }, transform)
                return (
                  <rect
                    x={a.x}
                    y={a.y}
                    width={site.floorWidthM * transform.scale}
                    height={site.floorHeightM * transform.scale}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.15}
                    strokeWidth={2}
                  />
                )
              })()
            : null}

          {cells.map((cell) => {
            const origin = toPixels({ x: cell.x as number, y: cell.y as number }, transform)
            const w = (cell.width as number) * transform.scale
            const h = (cell.height as number) * transform.scale
            const risk = RISK_STROKE[cell.riskClass] ?? RISK_STROKE.fenced
            const cellRobots = robots.filter((r) => r.cellId === cell.id)
            const positions = arrangeInCell(
              { x: cell.x as number, y: cell.y as number, width: cell.width as number, height: cell.height as number },
              cellRobots.length,
            )
            const output = perCell.get(cell.id)
            const isSelected = selected === cell.id

            return (
              <g key={cell.id} onClick={() => setSelected(isSelected ? null : cell.id)} style={{ cursor: 'pointer' }}>
                <rect
                  x={origin.x}
                  y={origin.y}
                  width={w}
                  height={h}
                  rx={4}
                  fill={isSelected ? 'currentColor' : 'currentColor'}
                  fillOpacity={isSelected ? 0.08 : 0.03}
                  stroke={risk.stroke}
                  strokeDasharray={risk.dash}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
                <text x={origin.x + 6} y={origin.y + 16} fontSize={12} fill="currentColor" fillOpacity={0.85}>
                  {cell.code}
                </text>
                <text x={origin.x + 6} y={origin.y + 30} fontSize={10} fill="currentColor" fillOpacity={0.5}>
                  {risk.label}
                </text>
                {output ? (
                  <text x={origin.x + 6} y={origin.y + h - 8} fontSize={10} fill="currentColor" fillOpacity={0.7}>
                    {output.producedKg.toFixed(0)} kg
                    {output.overclaim > 0 ? ` · ${output.overclaim} niedobór` : ''}
                    {output.visionSuspects > 0 ? ` · ${output.visionSuspects} wizja` : ''}
                  </text>
                ) : null}

                {cellRobots.map((robot, index) => {
                  const point = toPixels(positions[index] ?? { x: cell.x as number, y: cell.y as number }, transform)
                  const link = agents?.[robot.id]
                  /*
                   * Pierścień wokół kropki niesie łączność, wypełnienie niesie
                   * stan. To dwie różne rzeczy: robot „w ruchu", o którym
                   * centrala nic nie wie od pół godziny, wygląda inaczej niż
                   * robot w ruchu, który się odzywa.
                   *
                   * Trzy stany, nie dwa. Pierwsza wersja rysowała pierścień
                   * tylko przy ciszy, przez co **robot bez wpisanego agenta
                   * wyglądał identycznie jak robot z żywą łącznością** — czyli
                   * brak wiedzy udawał dobrą wiadomość. Widać to było dopiero
                   * na zrzucie ekranu, nie w kodzie.
                   */
                  const linkState: 'online' | 'stale' | 'absent' = agents === null
                    ? 'absent'
                    : link
                      ? (link.state === 'online' ? 'online' : 'stale')
                      : 'absent'
                  /*
                   * Pierścień „brak agenta" rysowany szerzej i luźniej niż
                   * „agent milczy", ale nadal wyraźnie. Pierwsza wersja miała
                   * kreskę 1/3 przy grubości 2 i była na rysunku niewidoczna —
                   * czyli wracała do tego samego błędu, który miała naprawić.
                   * Widać to było dopiero na zrzucie ekranu.
                   */
                  const ring =
                    linkState === 'stale'
                      ? { stroke: '#dc2626', width: 3, dash: '3 2', radius: 9 }
                      : linkState === 'absent'
                        ? { stroke: '#94a3b8', width: 2.5, dash: '2 2', radius: 12 }
                        : null
                  return (
                    <g key={robot.id}>
                      {/* Pierścień osobnym okręgiem, żeby nie zjadał wypełnienia. */}
                      {ring ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={ring.radius}
                          fill="none"
                          stroke={ring.stroke}
                          strokeWidth={ring.width}
                          strokeDasharray={ring.dash}
                        />
                      ) : null}
                      <circle cx={point.x} cy={point.y} r={9} fill={STATE_FILL[robot.state] ?? '#94a3b8'} />
                      {robot.calibrationState === 'blocked' ? (
                        <text x={point.x} y={point.y + 4} fontSize={11} textAnchor="middle" fill="#fff">
                          !
                        </text>
                      ) : null}
                      <title>
                        {`${robot.serialNumber} — ${STATE_LABEL[robot.state] ?? robot.state}` +
                          (linkState === 'absent' ? ', brak wpisanego agenta' : `, łączność: ${link!.state}`) +
                          (robot.calibrationState === 'blocked' ? ', kalibracja nieważna' : '')}
                      </title>
                    </g>
                  )
                })}
              </g>
            )
          })}

          {cells.length === 0 && !loading ? (
            <text x={VIEWPORT.width / 2} y={VIEWPORT.height / 2} textAnchor="middle" fontSize={13} fill="currentColor" fillOpacity={0.6}>
              Żadna cela nie ma obmiaru. Uruchom: mercato fleet layout
            </text>
          ) : null}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        {Object.entries(STATE_LABEL).slice(0, 6).map(([state, label]) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: STATE_FILL[state] }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-red-600" />
          agent milczy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-slate-400" />
          brak wpisanego agenta
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-slate-400 text-[9px] text-white">!</span>
          kalibracja nieważna
        </span>
      </div>

      {selectedCell ? (
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 text-sm font-medium">
            {selectedCell.name} <span className="font-normal text-muted-foreground">· {selectedCell.cellClass}</span>
          </div>
          <div className="divide-y">
            {selectedRobots.map((robot) => {
              const link = agents?.[robot.id]
              return (
                <div key={robot.id} className="flex flex-wrap items-center gap-x-4 px-4 py-2 text-xs">
                  <span className="w-32 font-mono">{robot.serialNumber}</span>
                  <span className="w-28" style={{ color: STATE_FILL[robot.state] }}>
                    {STATE_LABEL[robot.state] ?? robot.state}
                  </span>
                  <span className="w-40 text-muted-foreground">{robot.embodiment ?? '—'}</span>
                  <span className="w-44 text-muted-foreground">
                    {agents === null
                      ? 'warstwa łączności niedostępna'
                      : link
                        ? `łączność: ${link.state}`
                        : 'brak wpisanego agenta'}
                  </span>
                  <span className="flex-1 truncate text-muted-foreground">{robot.stateReason ?? ''}</span>
                </div>
              )
            })}
            {selectedRobots.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">Cela bez przypisanych robotów.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Nierozmieszczone — obok rysunku, nigdy na nim. */}
      {(layout?.unplacedCells?.length ?? 0) > 0 || (layout?.unassignedRobots ?? 0) > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs">
          <div className="mb-1 font-medium">Poza rzutem</div>
          {layout?.unplacedCells?.map((cell) => (
            <div key={cell.id} className="text-muted-foreground">
              {cell.code} — {cell.name}: brak obmiaru ({cell.robotCount} robotów)
            </div>
          ))}
          {layout?.unassignedRobots ? (
            <div className="text-muted-foreground">
              {layout.unassignedRobots} robotów bez przypisanej celi — stoją na hali, rejestr nie wie gdzie.
            </div>
          ) : null}
          <div className="mt-1 text-muted-foreground">
            Współrzędne nadaje się obmiarem, nie domysłem — dlatego te pozycje nie są zgadywane.
          </div>
        </div>
      ) : null}
    </div>
  )
}
