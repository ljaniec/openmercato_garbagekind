export const metadata = {
  requireAuth: true,
  requireFeatures: ['sortownia.view'],
  pageTitle: 'Pulpit sortowni',
  pageTitleKey: 'sortownia.dashboard.title',
  pageGroup: 'Sortownia',
  pageGroupKey: 'sortownia.title',
  pageOrder: 10,
  icon: 'recycle',
  breadcrumb: [{ label: 'Sortownia', labelKey: 'sortownia.title' }],
} as const
