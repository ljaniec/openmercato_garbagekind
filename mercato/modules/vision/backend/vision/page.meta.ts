export const metadata = {
  requireAuth: true,
  requireFeatures: ['vision.view'],
  pageTitle: 'Wzrok maszynowy',
  pageTitleKey: 'vision.panel.title',
  pageGroup: 'Produkcja',
  pageGroupKey: 'vision.nav.group',
  pageOrder: 20,
  icon: 'camera',
  breadcrumb: [{ label: 'Produkcja', labelKey: 'vision.nav.group' }],
} as const
