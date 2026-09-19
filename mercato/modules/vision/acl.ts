/**
 * Uprawnienia wzroku maszynowego.
 *
 * `vision.clips.view` jest wydzielone i celowo wąskie: materiał wideo z hali
 * to dane osobowe pracowników. Podgląd zliczeń („przejechało 1000 butelek")
 * i podgląd nagrania to dwie różne rzeczy i nie wolno ich rozdawać razem.
 */
export const features = [
  { id: 'vision.view', title: 'Podgląd zliczeń i kamer', module: 'vision' },
  { id: 'vision.manage', title: 'Rejestrowanie kamer i detektorów', module: 'vision' },
  { id: 'vision.clips.view', title: 'Dostęp do materiału wideo', module: 'vision' },
  { id: 'vision.clips.purge', title: 'Usuwanie materiału po terminie', module: 'vision' },
]

export default features
