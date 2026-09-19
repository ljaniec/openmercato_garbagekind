/**
 * Uprawnienia rejestru floty.
 *
 * Rozdzielone po ciężarze konsekwencji, nie po encjach: podgląd jest tani,
 * zmiana stanu rusza maszyną, a wycofanie robota jest nieodwracalne.
 */
export const features = [
  { id: 'fleet.view', title: 'Podgląd floty', module: 'fleet' },
  { id: 'fleet.manage', title: 'Zarządzanie rejestrem floty', module: 'fleet' },
  // Osobno od `manage`: przejście stanu dopuszcza maszynę do pracy albo ją
  // zatrzymuje. Technik, który rejestruje nowy robot, nie musi mieć prawa
  // wypuszczenia go na halę.
  { id: 'fleet.transition', title: 'Zmiana stanu robota', module: 'fleet' },
  { id: 'fleet.calibrate', title: 'Rejestrowanie kalibracji', module: 'fleet' },
  { id: 'fleet.decommission', title: 'Wycofywanie robotów', module: 'fleet' },
]

/**
 * Rejestr modułów sięga po `default`, tak samo jak przy `setup.ts`.
 * Sam nazwany eksport przechodzi bez błędu i bez skutku.
 */
export default features
