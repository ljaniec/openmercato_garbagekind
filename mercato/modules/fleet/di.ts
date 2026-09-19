import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Moduł nie wstrzykuje własnych usług: cała logika rozstrzygająca siedzi
 * w czystych funkcjach (`lib/lifecycle.ts`, `lib/calibration.ts`), a zapis
 * idzie komendami. Plik istnieje, żeby punkt rozszerzenia był na miejscu,
 * gdy pojawi się pierwsza usługa wymagająca stanu.
 */
export function register(_container: AppContainer): void {}
