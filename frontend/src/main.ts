import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import Home from './views/Home.vue'
import Collections from './views/Collections.vue'
import ProductDetail from './views/ProductDetail.vue'
import Order from './views/Order.vue'
import AdminLogin from './views/AdminLogin.vue'
import AdminDashboard from './views/AdminDashboard.vue'
import Account from './views/Account.vue'
import Support from './views/Support.vue'
import Blog from './views/Blog.vue'
import BlogDetail from './views/BlogDetail.vue'
import Docs from './views/Docs.vue'
import NotFound from './views/NotFound.vue'
import Legal from './views/Legal.vue'
import { i18n } from './i18n'
import { safeGetLocalStorage } from './api'
import './style.css'

// Keep route declarations in one place so navigation, SEO updates, and the
// admin guard all observe the same URL model.
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Home },
    { path: '/collections', component: Collections },
    { path: '/collections/:category', component: Collections },
    { path: '/products/:slug', component: ProductDetail },
    { path: '/support', component: Support },
    { path: '/policies/:type', component: Legal },
    { path: '/blog', component: Blog },
    { path: '/blog/:slug', component: BlogDetail },
    { path: '/doc', component: Docs },
    { path: '/doc/', component: Docs },
    { path: '/doc/:pathMatch(.*)*', component: Docs },
    { path: '/order', component: Order },
    { path: '/account', component: Account },
    { path: '/admin', component: AdminLogin },
    { path: '/admin/dashboard', component: AdminDashboard },
    { path: '/:pathMatch(.*)*', component: NotFound }
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
