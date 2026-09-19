/**
 * Uprawnienia kanału brzegowego.
 *
 * `edge.enroll` jest wydzielone i celowo wąskie: kto może wystawić bilet
 * wpisowy, ten może wpuścić do floty nową maszynę. To uprawnienie o ciężarze
 * porównywalnym z dodaniem użytkownika, nie z edycją opisu.
 */
export const features = [
  { id: 'edge.view', title: 'Podgląd łączności agentów', module: 'edge' },
  { id: 'edge.enroll', title: 'Wystawianie biletów wpisowych', module: 'edge' },
  { id: 'edge.rotate', title: 'Rotacja kluczy agentów', module: 'edge' },
  { id: 'edge.revoke', title: 'Odwoływanie agentów', module: 'edge' },
]
