export const metadata = {
  requireAuth: true,
  requireFeatures: ['fleet.view'],
  pageTitle: 'Roboty',
  pageTitleKey: 'fleet.robots.title',
  pageGroup: 'Flota',
  pageGroupKey: 'fleet.nav.group',
  pageOrder: 10,
  icon: 'cpu',
  breadcrumb: [{ label: 'Flota', labelKey: 'fleet.nav.group' }],
} as const
