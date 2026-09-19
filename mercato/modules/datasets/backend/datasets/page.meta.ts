export const metadata = {
  requireAuth: true,
  requireFeatures: ['datasets.view'],
  pageTitle: 'Zbiory danych',
  pageTitleKey: 'datasets.datasets.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'datasets.nav.group',
  pageOrder: 80,
  icon: 'database',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'datasets.nav.group' }],
} as const
