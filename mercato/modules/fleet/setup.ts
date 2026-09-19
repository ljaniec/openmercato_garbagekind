import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Domyślne nadanie uprawnień rolom przy instalacji modułu.
 *
 * Operator floty dostaje podgląd, zmianę stanu i kalibrację — bo to on
 * zatrzymuje i wypuszcza maszyny. Wycofanie zostaje przy administratorze:
 * to decyzja nieodwracalna, unieważniająca trwale tożsamość agenta.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany eksport `setup`.
 * Sam `defaultRoleFeatures` nie zostanie zauważony i uprawnienia po cichu
 * nie powstaną — nauczka kosztująca jeden przebieg diagnostyczny.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['fleet.*'],
    employee: ['fleet.view', 'fleet.transition', 'fleet.calibrate'],
  },
}

export default setup
