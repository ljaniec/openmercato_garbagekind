import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Calibration, EmbodimentRevision, Robot, RobotTransition, type RobotState } from '../data/entities'
import { checkTransition, type TransitionActor } from '../lib/lifecycle'
import { evaluateCalibration } from '../lib/calibration'

/**
 * Komendy rejestru floty.
 *
 * Wszystko idzie szyną komend, nie zapisem do encji — bo w produkcie, gdzie
 * zła operacja porusza tonową maszyną w przestrzeni z ludźmi, „każdy zapis
 * zostawia log z aktorem i snapshotem przed/po" jest wymaganiem, nie wygodą.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const robotStates = [
  'registered',
  'commissioning',
  'ready',
  'operational',
  'maintenance',
  'quarantined',
  'decommissioning',
  'decommissioned',
] as const

export const robotRegisterSchema = scoped.extend({
  serialNumber: z.string().trim().min(1).max(191),
  name: z.string().trim().min(1).max(191),
  embodimentRevisionId: z.string().uuid(),
  /**
   * Właściciel i operator są osobno i oba są wymagane.
   *
   * Brak wartości domyślnej jest celowy: „właściciel = operator" ma być
   * decyzją zapisaną przy rejestracji, a nie założeniem, które ujawni się
   * dopiero wtedy, gdy wejdzie integrator.
   */
  ownerOrganizationId: z.string().uuid(),
  operatorOrganizationId: z.string().uuid(),
  cellId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const robotTransitionSchema = scoped.extend({
  robotId: z.string().uuid(),
  toState: z.enum(robotStates),
  reason: z.string().trim().min(1).max(500),
  actor: z.enum(['human', 'system']).default('human'),
  /**
   * Potwierdzenie bramki wymagającej podpisu.
   *
   * Świadomie nie jest to „siła" ani „pomiń kontrolę": przejście i tak musi
   * być dozwolone w grafie. To jest jawna deklaracja, że człowiek bierze
   * odpowiedzialność za dopuszczenie maszyny — i ląduje w dzienniku audytu.
   */
  approvedBy: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const calibrationRecordSchema = scoped.extend({
  robotId: z.string().uuid(),
  kind: z.string().trim().min(1).max(120),
  measuredAt: z.coerce.date(),
  validUntil: z.coerce.date(),
  values: z.record(z.string(), z.unknown()).optional(),
  uncertainty: z.record(z.string(), z.unknown()).optional(),
  measuredBy: z.string().uuid().optional(),
})

export type RobotRegisterInput = z.infer<typeof robotRegisterSchema>
export type RobotTransitionInput = z.infer<typeof robotTransitionSchema>
export type CalibrationRecordInput = z.infer<typeof calibrationRecordSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

const registerRobotCommand: CommandHandler<RobotRegisterInput, { robotId: string }> = {
  id: 'fleet.robots.register',
  async execute(rawInput, ctx) {
    const input = robotRegisterSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const revision = await em.findOne(EmbodimentRevision, {
      id: input.embodimentRevisionId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)
    if (!revision) {
      // Robot bez rewizji embodimentu jest rekordem, do którego nigdy nie da
      // się przypisać polityki — lepiej odmówić przy rejestracji.
      throw new Error(`Rewizja embodimentu ${input.embodimentRevisionId} nie istnieje w tym tenancie.`)
    }

    const existing = await em.findOne(Robot, {
      tenantId: input.tenantId,
      serialNumber: input.serialNumber,
    } as never)
    if (existing) {
      // Numer seryjny jest tożsamością. Powtórzona rejestracja to prawie zawsze
      // drugi import tej samej floty, a nie druga maszyna.
      throw new Error(`Robot o numerze ${input.serialNumber} już istnieje w tym tenancie.`)
    }

    const robot = em.create(Robot, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      ownerOrganizationId: input.ownerOrganizationId,
      operatorOrganizationId: input.operatorOrganizationId,
      serialNumber: input.serialNumber,
      name: input.name,
      embodimentRevisionId: input.embodimentRevisionId,
      cellId: input.cellId ?? null,
      state: 'registered' as RobotState,
      stateReason: 'Rejestracja w systemie',
      stateChangedAt: new Date(),
      metadata: input.metadata ?? null,
    } as never)

    // Dwa zapisy, nie jeden: identyfikator nadaje Postgres
    // (`defaultRaw: gen_random_uuid()`), więc przed pierwszym zrzutem
    // `robot.id` jest jeszcze puste i wpis do księgi przejść nie miałby na co
    // wskazać. Alternatywą byłoby generowanie UUID po stronie aplikacji —
    // odrzucone, bo wtedy baza przestaje być jedynym źródłem tożsamości.
    em.persist(robot)
    await em.flush()

    const robotId = (robot as unknown as { id: string }).id
    em.persist(
      em.create(RobotTransition, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        robotId,
        fromState: null,
        toState: 'registered' as RobotState,
        reason: 'Rejestracja w systemie',
        actorUserId: ctx.auth?.sub ?? null,
      } as never),
    )
    await em.flush()

    return { robotId }
  },
}

const transitionRobotCommand: CommandHandler<
  RobotTransitionInput,
  { robotId: string; fromState: RobotState; toState: RobotState }
> = {
  id: 'fleet.robots.transition',
  async execute(rawInput, ctx) {
    const input = robotTransitionSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const robot = await em.findOne(Robot, {
      id: input.robotId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)
    if (!robot) throw new Error(`Robot ${input.robotId} nie istnieje.`)

    const current = (robot as unknown as { state: RobotState }).state
    const check = checkTransition(current, input.toState, input.actor as TransitionActor)
    if (!check.allowed) throw new Error(check.reason ?? 'Przejście niedozwolone.')

    if (check.requiresApproval && !input.approvedBy) {
      throw new Error(
        `Przejście ${current} → ${input.toState} wymaga podpisu człowieka (pole approvedBy).`,
      )
    }

    // Dopuszczenie do pracy sprawdza kalibrację przy samej bramce, a nie
    // dopiero przy wdrożeniu polityki. Robot z przeterminowanym pomiarem
    // wygląda w każdym zestawieniu identycznie jak sprawny — i to jest
    // dokładnie ten moment, w którym ta różnica musi wyjść.
    if (input.toState === 'ready') {
      const verdict = await evaluateRobotCalibration(em, robot as never, input.tenantId)
      if (!verdict.complete) {
        throw new Error(`Nie można dopuścić robota: ${verdict.reason}.`)
      }
    }

    const target = robot as unknown as {
      id: string
      state: RobotState
      stateReason?: string | null
      stateChangedAt?: Date | null
    }
    target.state = input.toState
    target.stateReason = input.reason
    target.stateChangedAt = new Date()

    em.persist(
      em.create(RobotTransition, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        robotId: target.id,
        fromState: current,
        toState: input.toState,
        reason: input.reason,
        // `null` znaczy system — i to jest informacja, nie brak informacji.
        actorUserId: input.actor === 'system' ? null : input.approvedBy ?? ctx.auth?.sub ?? null,
        metadata: input.metadata ?? null,
      } as never),
    )
    await em.flush()

    return { robotId: target.id, fromState: current, toState: input.toState }
  },
}

const recordCalibrationCommand: CommandHandler<CalibrationRecordInput, { calibrationId: string }> = {
  id: 'fleet.calibrations.record',
  async execute(rawInput, ctx) {
    const input = calibrationRecordSchema.parse(rawInput ?? {})
    if (input.validUntil.getTime() <= input.measuredAt.getTime()) {
      throw new Error('Data ważności kalibracji musi być późniejsza niż data pomiaru.')
    }

    const em = resolveEm(ctx)
    const robot = await em.findOne(Robot, {
      id: input.robotId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)
    if (!robot) throw new Error(`Robot ${input.robotId} nie istnieje.`)

    const calibration = em.create(Calibration, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      kind: input.kind,
      measuredAt: input.measuredAt,
      validUntil: input.validUntil,
      values: input.values ?? null,
      uncertainty: input.uncertainty ?? null,
      measuredBy: input.measuredBy ?? ctx.auth?.sub ?? null,
    } as never)

    em.persist(calibration)
    await em.flush()

    return { calibrationId: (calibration as unknown as { id: string }).id }
  },
}

/** Werdykt kalibracyjny dla robota — wymagania bierze z jego rewizji embodimentu. */
export async function evaluateRobotCalibration(
  em: EntityManager,
  robot: { id: string; embodimentRevisionId: string },
  tenantId: string,
  now: Date = new Date(),
) {
  const revision = await em.findOne(EmbodimentRevision, {
    id: robot.embodimentRevisionId,
    tenantId,
  } as never)
  const required = ((revision as unknown as { requiredCalibrations?: string[] | null })
    ?.requiredCalibrations ?? []) as string[]

  const records = (await em.find(Calibration, {
    robotId: robot.id,
    tenantId,
  } as never)) as unknown as Array<{
    kind: string
    measuredAt: Date
    validUntil: Date
    invalidatedAt?: Date | null
  }>

  return evaluateCalibration(required, records, now)
}

registerCommand(registerRobotCommand)
registerCommand(transitionRobotCommand)
registerCommand(recordCalibrationCommand)

export { registerRobotCommand, transitionRobotCommand, recordCalibrationCommand }
