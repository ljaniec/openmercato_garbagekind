export const metadata = {
  requireAuth: true,
  requireFeatures: ['deployment.view'],
  pageTitle: 'Wdrożenia',
  pageTitleKey: 'deployment.assignments.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'deployment.nav.group',
  pageOrder: 40,
  icon: 'upload-cloud',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'deployment.nav.group' }],
} as const
