import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['reality_layer.*'],
    employee: [
      'reality_layer.intent.view',
      'reality_layer.intent.create',
      'reality_layer.executor.view',
      'reality_layer.evidence.view',
      'reality_layer.diff.view',
    ],
  },
}

export default setup
