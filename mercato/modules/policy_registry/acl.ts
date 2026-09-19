/**
 * Uprawnienia rejestru polityk.
 *
 * Podział po ciężarze konsekwencji, nie po encjach. Kluczowe jest wydzielenie
 * `release`: zarejestrowanie wersji to wgranie pliku, a wypuszczenie jej to
 * zgoda na to, żeby ta wersja ruszyła maszyną. Inżynier ML robi pierwsze,
 * niekoniecznie drugie.
 */
export const features = [
  { id: 'policy_registry.view', title: 'Podgląd rejestru polityk', module: 'policy_registry' },
  { id: 'policy_registry.manage', title: 'Rejestrowanie polityk i wersji', module: 'policy_registry' },
  { id: 'policy_registry.release', title: 'Wypuszczanie wersji polityki', module: 'policy_registry' },
  { id: 'policy_registry.deprecate', title: 'Wycofywanie wersji polityki', module: 'policy_registry' },
]

/** Rejestr modułów sięga po `default`. Sam nazwany eksport przechodzi bez skutku. */
export default features
