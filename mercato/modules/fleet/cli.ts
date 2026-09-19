import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { Cell, EmbodimentRevision, Robot, Site, type RobotState } from './data/entities'
import { evaluateRobotCalibration } from './commands/robots'
import { isActive } from './lib/lifecycle'

/**
 * Komendy operatorskie rejestru floty.
 *
 * `seed` zakłada wiarygodny punkt wyjścia: obiekt, cele, dwie rewizje
 * embodimentu i flotę manipulatorów. `status` odpowiada na pytanie, od
 * którego zaczyna się każde wdrożenie — ile rejestr twierdzi, że istnieje,
 * i ile z tego wolno uruchomić.
 */

type Scope = { tenantId: string; organizationId: string }

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [key, value] = part.slice(2).split('=')
    if (value !== undefined) args[key] = value
    else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) {
      args[key] = rest[index + 1]!
      index += 1
    } else args[key] = true
  }
  return args
}

async function resolveScope(em: EntityManager, args: Record<string, string | boolean>): Promise<Scope> {
  const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
  const organizationId = typeof args.org === 'string' ? args.org : ''
  if (tenantId && organizationId) return { tenantId, organizationId }

  const rows = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select tenant_id, id from organizations where deleted_at is null order by created_at asc limit 1',
  )
  if (!rows?.length) throw new Error('Brak organizacji — uruchom najpierw inicjalizację aplikacji.')
  return { tenantId: rows[0].tenant_id, organizationId: rows[0].id }
}

function buildCommandContext(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  scope: Scope,
): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
    },
  } as unknown as CommandRuntimeContext
}

/**
 * Flota demonstracyjna: dwie klasy sprzętowe, jedna cela ogrodzona.
 *
 * Celowo niewygodna w jednym miejscu — jeden robot dostaje kalibrację, która
 * wygasa za trzy dni, a drugi nie dostaje jej wcale. Flota, w której wszystko
 * jest zielone, nie pokazuje niczego, co ten rejestr ma pokazywać.
 */
const EMBODIMENTS = [
  {
    key: 'ur10e-pick',
    revision: 1,
    name: 'UR10e — stanowisko odkładcze',
    dofCount: 6,
    requiredCalibrations: ['camera_extrinsics', 'tool_center_point'],
  },
  {
    key: 'fr3-assembly',
    revision: 1,
    name: 'Franka FR3 — montaż',
    dofCount: 7,
    requiredCalibrations: ['camera_extrinsics', 'joint_offsets'],
  },
]

const ROBOTS = [
  { serial: 'UR10E-0001', name: 'Odkładanie A', embodiment: 'ur10e-pick', calib: 'full' },
  { serial: 'UR10E-0002', name: 'Odkładanie B', embodiment: 'ur10e-pick', calib: 'expiring' },
  { serial: 'UR10E-0003', name: 'Odkładanie C', embodiment: 'ur10e-pick', calib: 'none' },
  { serial: 'FR3-0001', name: 'Montaż 1', embodiment: 'fr3-assembly', calib: 'full' },
  { serial: 'FR3-0002', name: 'Montaż 2', embodiment: 'fr3-assembly', calib: 'full' },
] as const

const seedCommand: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const commandBus = container.resolve('commandBus') as CommandBus
    const scope = await resolveScope(em, args)
    const commandContext = buildCommandContext(container, scope)

    /**
     * Organizacja integratora.
     *
     * Bez podania `--integrator` właściciel i operator są tym samym podmiotem
     * i rejestr wygląda jak w każdym systemie z jedną kolumną organizacji.
     * Dopiero rozdzielenie pokazuje, po co ten rozdział istnieje.
     */
    const integratorOrg =
      typeof args.integrator === 'string' ? args.integrator : scope.organizationId

    console.log(`Flota: zasiew do organizacji ${scope.organizationId} (tenant ${scope.tenantId})`)

    // 1. Obiekt i cela — jednostka koperty bezpieczeństwa.
    let site = await em.findOne(Site, { tenantId: scope.tenantId, code: 'ZAK1' } as never)
    if (!site) {
      site = em.create(Site, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        code: 'ZAK1',
        name: 'Zakład Wieliszew',
        timezone: 'Europe/Warsaw',
        address: 'ul. Składowa 2, Wieliszew',
      } as never)
      em.persist(site)
      await em.flush()
    }

    let cell = await em.findOne(Cell, {
      tenantId: scope.tenantId,
      siteId: (site as unknown as { id: string }).id,
      code: 'CELA-A',
    } as never)
    if (!cell) {
      cell = em.create(Cell, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        siteId: (site as unknown as { id: string }).id,
        code: 'CELA-A',
        name: 'Cela A — gniazdo odkładcze',
        cellClass: 'fenced-pick-place',
        // Cela ogrodzona: dzierżawa w dniach, odcięcie chmury nie zatrzymuje produkcji.
        riskClass: 'fenced',
      } as never)
      em.persist(cell)
      await em.flush()
    }

    // 2. Rewizje embodimentu — kontrakt, do którego wiąże się polityka.
    const revisionByKey = new Map<string, string>()
    for (const entry of EMBODIMENTS) {
      let revision = await em.findOne(EmbodimentRevision, {
        tenantId: scope.tenantId,
        embodimentKey: entry.key,
        revision: entry.revision,
      } as never)
      if (!revision) {
        revision = em.create(EmbodimentRevision, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          embodimentKey: entry.key,
          revision: entry.revision,
          name: entry.name,
          // W prawdziwym wdrożeniu to hash kanonicznej postaci kontraktu.
          // Tutaj deterministyczny zastępnik — robot i tak porówna go bit po bicie.
          specDigest: `demo:${entry.key}:r${entry.revision}`,
          dofCount: entry.dofCount,
          requiredCalibrations: entry.requiredCalibrations,
        } as never)
        em.persist(revision)
        await em.flush()
      }
      revisionByKey.set(entry.key, (revision as unknown as { id: string }).id)
    }
    console.log(`  klasy sprzętowe: ${revisionByKey.size}`)

    // 3. Roboty — przez komendę, nie zapisem do encji.
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    let created = 0
    let skipped = 0

    for (const entry of ROBOTS) {
      const existing = await em.findOne(Robot, {
        tenantId: scope.tenantId,
        serialNumber: entry.serial,
      } as never)
      if (existing) {
        skipped += 1
        continue
      }

      const result = (await commandBus.execute('fleet.robots.register', {
        input: {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          ownerOrganizationId: scope.organizationId,
          // Manipulatory montażowe obsługuje integrator — i to jest cała
          // treść decyzji o rozdziale właściciela od operatora.
          operatorOrganizationId:
            entry.embodiment === 'fr3-assembly' ? integratorOrg : scope.organizationId,
          serialNumber: entry.serial,
          name: entry.name,
          embodimentRevisionId: revisionByKey.get(entry.embodiment) as string,
          cellId: (cell as unknown as { id: string }).id,
        },
        ctx: commandContext,
      })) as { result?: { robotId?: string } }

      const robotId = result?.result?.robotId
      if (!robotId) continue
      created += 1

      // 4. Kalibracje — trzy warianty, żeby rejestr miał co pokazać.
      if (entry.calib !== 'none') {
        const required = EMBODIMENTS.find((e) => e.key === entry.embodiment)!.requiredCalibrations
        const validDays = entry.calib === 'expiring' ? 3 : 120
        for (const kind of required) {
          await commandBus.execute('fleet.calibrations.record', {
            input: {
              organizationId: scope.organizationId,
              tenantId: scope.tenantId,
              robotId,
              kind,
              measuredAt: new Date(now - 7 * DAY),
              validUntil: new Date(now + validDays * DAY),
              values: { demo: true },
            },
            ctx: commandContext,
          })
        }
      }

      // 5. Przeprowadzenie przez cykl życia — tylko tam, gdzie kalibracja pozwala.
      await commandBus.execute('fleet.robots.transition', {
        input: {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          robotId,
          toState: 'commissioning',
          reason: 'Uruchomienie po dostawie',
        },
        ctx: commandContext,
      })

      if (entry.calib !== 'none') {
        await commandBus.execute('fleet.robots.transition', {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            robotId,
            toState: 'ready',
            reason: 'Testy odbiorcze zaliczone',
            // Bramka wymaga podpisu — zasiew deklaruje go jawnie zamiast omijać.
            approvedBy: scope.organizationId,
          },
          ctx: commandContext,
        })
        await commandBus.execute('fleet.robots.transition', {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            robotId,
            toState: 'operational',
            reason: 'Wprowadzenie do ruchu',
          },
          ctx: commandContext,
        })
      }
    }

    console.log(`  roboty: ${ROBOTS.length} w definicji (nowych ${created}, istniejących ${skipped})`)
    console.log('  robot UR10E-0003 zostaje w uruchamianiu — nie ma kalibracji i to jest zamierzone')
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const robots = (await em.find(Robot, {
      tenantId: scope.tenantId,
      deletedAt: null,
    } as never)) as unknown as Array<{
      id: string
      serialNumber: string
      name: string
      state: RobotState
      stateReason: string | null
      embodimentRevisionId: string
      ownerOrganizationId: string
      operatorOrganizationId: string
    }>

    if (!robots.length) {
      console.log('Rejestr jest pusty. Uruchom: yarn mercato fleet seed')
      return
    }

    console.log(`Rejestr floty (tenant ${scope.tenantId}): ${robots.length} robotów\n`)
    console.log('  numer          stan            kalibracja                        uwagi')
    console.log('  ' + '-'.repeat(88))

    let czynne = 0
    let zablokowane = 0

    for (const robot of robots.sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))) {
      const verdict = await evaluateRobotCalibration(em, robot, scope.tenantId)
      if (isActive(robot.state)) czynne += 1
      if (!verdict.complete) zablokowane += 1

      const kalibracja = verdict.complete
        ? 'komplet ważny'
        : (verdict.reason ?? 'niekompletna').slice(0, 32)
      const uwagi =
        robot.ownerOrganizationId !== robot.operatorOrganizationId ? 'obsługuje integrator' : ''

      console.log(
        `  ${robot.serialNumber.padEnd(14)} ${robot.state.padEnd(15)} ${kalibracja.padEnd(33)} ${uwagi}`,
      )
    }

    console.log('')
    console.log(`  czynnych: ${czynne} z ${robots.length}`)
    console.log(`  z niekompletną kalibracją: ${zablokowane}`)
    // To jest liczba, od której zaczyna się każde wdrożenie: rejestr kontra hala.
    console.log('')
    console.log('  Porównaj tę liczbę z tym, co faktycznie stoi w hali.')
    console.log('  W każdym wdrożeniu się nie zgadza i to jest pierwsza wartość tej platformy.')
  },
}

export default [seedCommand, statusCommand] satisfies ModuleCli[]
