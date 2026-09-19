export const metadata = {
  requireAuth: true,
  requireFeatures: ['safety.view'],
  pageTitle: 'Bezpieczeństwo',
  pageTitleKey: 'safety.clearance.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'safety.nav.group',
  pageOrder: 70,
  icon: 'shield',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'safety.nav.group' }],
} as const
