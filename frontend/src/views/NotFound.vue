<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { setHead } from '../head'

const { locale, t } = useI18n()

function updateHead() {
  setHead(t('notFound.title'), t('notFound.desc'), { canonical: `${window.location.origin}/`, robots: 'noindex,follow' })
}

updateHead()
watch(locale, updateHead)
</script>

<template>
  <main class="section narrow">
    <section class="panel not-found-panel">
      <p class="eyebrow">{{ t('notFound.eyebrow') }}</p>
      <h1>{{ t('notFound.title') }}</h1>
      <p class="muted">{{ t('notFound.desc') }}</p>
      <div class="row-actions">
        <RouterLink class="button primary" to="/">{{ t('notFound.home') }}</RouterLink>
        <RouterLink class="button ghost" to="/collections">{{ t('notFound.collections') }}</RouterLink>
      </div>
    </section>
  </main>
</template>
