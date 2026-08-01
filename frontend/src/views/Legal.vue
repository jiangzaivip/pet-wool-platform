<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ArrowLeft } from '@lucide/vue'
import { setHead } from '../head'

const route = useRoute()
const { locale, t } = useI18n()
const policyKeys = ['privacy', 'terms', 'refund', 'shipping', 'cookies'] as const
type PolicyKey = typeof policyKeys[number]
const policyKey = computed<PolicyKey>(() => {
  const candidate = String(route.params.type || '') as PolicyKey
  return policyKeys.includes(candidate) ? candidate : 'privacy'
})
const title = computed(() => t(`legal.${policyKey.value}Title`))
const body = computed(() => t(`legal.${policyKey.value}Body`))

function updateHead() {
  setHead(`${title.value} | WoolBuddy`, body.value, {
    canonical: `${window.location.origin}/policies/${policyKey.value}`
  })
}

onMounted(updateHead)
watch([locale, policyKey], updateHead)
</script>

<template>
  <main class="section legal-page">
    <article class="article-shell legal-article">
      <p class="eyebrow">{{ t('legal.eyebrow') }}</p>
      <h1>{{ title }}</h1>
      <p class="muted">{{ t('legal.updated') }}</p>
      <p class="lead preserve-lines">{{ body }}</p>
      <RouterLink class="button ghost" to="/support"><ArrowLeft :size="17" />{{ t('legal.back') }}</RouterLink>
    </article>
  </main>
</template>
