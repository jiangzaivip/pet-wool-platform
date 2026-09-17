export const adminTabs = ['overview', 'users', 'categories', 'products', 'orders', 'reviews', 'blog', 'paypal', 'site', 'audit', 'readiness'] as const
export type AdminTab = typeof adminTabs[number]
export type AdminResource = 'overview' | 'users' | 'categories' | 'products' | 'orders' | 'site' | 'audit'

export const adminDependencies: Record<AdminTab, AdminResource[]> = {
  overview: ['overview', 'orders'],
  users: ['users'],
  categories: ['categories', 'products'],
  products: ['products', 'categories', 'site'],
  orders: ['orders'],
  reviews: ['site'],
  blog: ['site'],
  paypal: ['site'],
  site: ['site'],
  audit: ['audit'],
  readiness: ['site', 'categories', 'products'],
}

export function normalizeAdminTab(value: unknown): AdminTab {
  return typeof value === 'string' && adminTabs.includes(value as AdminTab) ? value as AdminTab : 'overview'
}

export function preserveOrderNote<T extends Record<string, any>>(order: T, drafts: Map<string, string>): T {
  return drafts.has(order.id) ? { ...order, internal_note: drafts.get(order.id) } : order
}
