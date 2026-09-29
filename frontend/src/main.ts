import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
// Only the three primary-funnel views are imported eagerly; the rest are
// reached through the lazy route factories below. Keeping a static import
// here would pull that view back into the entry chunk and defeat the split.
import Home from './views/Home.vue'
import Collections from './views/Collections.vue'
import ProductDetail from './views/ProductDetail.vue'
import { i18n } from './i18n'
import { safeGetLocalStorage } from './api'
import './style.css'

// Keep route declarations in one place so navigation, SEO updates, and the
// admin guard all observe the same URL model.
const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Home, Collections and ProductDetail stay eager: they are the entry points
    // search engines and the first ad/session funnel land on, so a lazy chunk
    // there would only add a round trip. Everything below the fold of the
    // primary funnel is loaded on demand.
    { path: '/', component: Home },
    { path: '/collections', component: Collections },
    { path: '/collections/:category', component: Collections },
    { path: '/products/:slug', component: ProductDetail },
    { path: '/support', component: () => import('./views/Support.vue') },
    { path: '/policies/:type', component: () => import('./views/Legal.vue') },
    { path: '/blog', component: () => import('./views/Blog.vue') },
    { path: '/blog/:slug', component: () => import('./views/BlogDetail.vue') },
    { path: '/doc', component: () => import('./views/Docs.vue') },
    { path: '/doc/', component: () => import('./views/Docs.vue') },
    { path: '/doc/:pathMatch(.*)*', component: () => import('./views/Docs.vue') },
    { path: '/order', component: () => import('./views/Order.vue') },
    { path: '/account', component: () => import('./views/Account.vue') },
    { path: '/admin', component: () => import('./views/AdminLogin.vue') },
    { path: '/admin/dashboard', component: () => import('./views/AdminDashboard.vue') },
    { path: '/:pathMatch(.*)*', component: () => import('./views/NotFound.vue') }
  ]
})

router.beforeEach((to) => {
  // The API remains the authority for admin authorization. This guard only
  // avoids rendering the dashboard shell for an obviously anonymous browser.
  if (to.path.startsWith('/admin/dashboard') && !safeGetLocalStorage('admin_token')) {
    return '/admin'
  }
  return true
})

createApp(App).use(createPinia()).use(i18n).use(router).mount('#app')
