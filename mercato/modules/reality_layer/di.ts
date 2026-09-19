import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * M1 deliberately has no stateful singleton services. Reality Gate, executor
 * registry and credential providers arrive in later phases.
 */
export function register(_container: AppContainer): void {}
