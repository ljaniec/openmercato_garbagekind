import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Pracownik widzi zliczenia, bo to informacja o produkcji. **Nie** dostaje
 * dostępu do nagrań — te są danymi osobowymi jego i jego kolegów, a art. 22²
 * Kodeksu pracy nie robi z monitoringu narzędzia powszechnie dostępnego.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['vision.*'],
    employee: ['vision.view'],
  },
}

export default setup
