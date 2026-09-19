export const metadata = {
  requireAuth: true,
  requireFeatures: ['episodes.view'],
  pageTitle: 'Epizody',
  pageTitleKey: 'episodes.cadence.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'episodes.nav.group',
  pageOrder: 50,
  icon: 'activity',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'episodes.nav.group' }],
} as const
