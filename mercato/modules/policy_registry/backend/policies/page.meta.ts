export const metadata = {
  requireAuth: true,
  requireFeatures: ['policy_registry.view'],
  pageTitle: 'Polityki',
  pageTitleKey: 'policy_registry.policies.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'policy_registry.nav.group',
  pageOrder: 30,
  icon: 'brain',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'policy_registry.nav.group' }],
} as const
