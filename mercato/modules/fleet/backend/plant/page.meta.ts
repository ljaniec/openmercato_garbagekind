export const metadata = {
  requireAuth: true,
  requireFeatures: ['fleet.view'],
  pageTitle: 'Rzut hali',
  pageTitleKey: 'fleet.plant.title',
  pageGroup: 'Flota',
  pageGroupKey: 'fleet.nav.group',
  pageOrder: 5,
  icon: 'map',
  breadcrumb: [{ label: 'Flota', labelKey: 'fleet.nav.group' }],
} as const
