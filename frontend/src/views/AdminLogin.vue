<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api, safeGetLocalStorage, safeRemoveLocalStorage, safeSetLocalStorage } from '../api'

const router = useRouter()
const { t } = useI18n()
const error = ref('')
const loading = ref(false)
const form = reactive({ email: '', password: '' })

async function login() {
  if (loading.value) return
  error.value = ''
  loading.value = true
  try {
    const result = await api<{ token: string; email: string }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify(form)
    })
    if (!safeSetLocalStorage('admin_token', result.token)) {
      error.value = t('common.loadFailed')
      return
    }
    await router.replace('/admin/dashboard')
  } catch (e: any) {
    error.value = String(e.message || '') === 'invalid credentials'
      ? t('admin.loginFailed')
      : (e.message || t('common.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!safeGetLocalStorage('admin_token')) return
  loading.value = true
  try {
    await api('/admin/overview')
    await router.replace('/admin/dashboard')
  } catch {
    safeRemoveLocalStorage('admin_token')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="section admin-login">
    <form class="panel" @submit.prevent="login">
      <h1>{{ t('admin.login') }}</h1>
      <p class="security-note">{{ t('admin.loginSecurityNote') }}</p>
      <label>{{ t('admin.email') }}<input v-model="form.email" type="email" placeholder="admin@example.com" :disabled="loading" required /></label>
      <label>{{ t('admin.password') }}<input v-model="form.password" type="password" :disabled="loading" required /></label>
      <button class="button primary" :disabled="loading">{{ loading ? t('common.loading') : t('admin.submit') }}</button>
      <p class="form-message error" :class="{ empty: !error }" aria-live="polite">{{ error || t('admin.loginIdleMessage') }}</p>
    </form>
  </main>
</template>
