import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { sortowniaLegacyAdapter } from './lib/adapter'

export function register(_container: AppContainer) {
  // Adapter jest bezstanowy: cały stan przebiegu trzyma data_sync (kursor, run, logi).
  registerDataSyncAdapter(sortowniaLegacyAdapter)
}
