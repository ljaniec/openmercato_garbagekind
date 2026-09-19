export const metadata = {
  requireAuth: true,
  requireFeatures: ['work_orders.view'],
  pageTitle: 'Panel przedsiębiorstwa',
  pageTitleKey: 'work_orders.panel.title',
  pageGroup: 'Produkcja',
  pageGroupKey: 'work_orders.nav.group',
  pageOrder: 10,
  icon: 'factory',
  breadcrumb: [{ label: 'Produkcja', labelKey: 'work_orders.nav.group' }],
} as const
