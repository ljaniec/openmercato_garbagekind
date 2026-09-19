import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Bez własnych usług: rozstrzyganie siedzi w czystych funkcjach
 * (`lib/liveness.ts`, `lib/crypto.ts`), a zapis idzie komendami.
 */
export function register(_container: AppContainer): void {}
