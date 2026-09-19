import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Podgląd łączności dostaje każdy pracownik — bo pytanie „czy ten robot
 * w ogóle się odzywa" pada przy każdej awarii i blokowanie go tylko wydłuża
 * drogę do odpowiedzi.
 *
 * Wpis, rotacja i odwołanie zostają przy administratorze: to operacje na
 * tożsamości, a nie na danych.
 *
 * Kontrakt generatora wymaga eksportu `default` albo nazwanego `setup`;
 * sam `defaultRoleFeatures` przechodzi bez błędu i bez skutku.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['edge.*'],
    employee: ['edge.view'],
  },
}

export default setup
