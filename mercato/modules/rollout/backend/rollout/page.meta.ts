export const metadata = {
  requireAuth: true,
  requireFeatures: ['rollout.view'],
  pageTitle: 'Wdrożenia etapowe',
  pageTitleKey: 'rollout.rollouts.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'rollout.nav.group',
  pageOrder: 60,
  icon: 'git-branch',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'rollout.nav.group' }],
} as const
