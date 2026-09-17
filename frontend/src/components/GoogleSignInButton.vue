<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { mountGoogleSignInButton } from '../api'

const props = defineProps<{
  clientId: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  credential: [token: string]
  error: [message: string]
}>()

const container = ref<HTMLElement | null>(null)
let renderSequence = 0

async function renderButton() {
  const sequence = ++renderSequence
  if (!props.clientId || !container.value) return
  try {
    await mountGoogleSignInButton(container.value, props.clientId, (token) => {
      if (sequence === renderSequence) emit('credential', token)
    })
  } catch (error: any) {
    if (sequence === renderSequence) emit('error', String(error?.message || 'google identity failed'))
  }
}

watch(() => props.clientId, renderButton)
onMounted(renderButton)

onBeforeUnmount(() => {
  renderSequence += 1
  container.value?.replaceChildren()
})
</script>

<template>
  <div ref="container" class="google-signin-button" :class="{ disabled }" aria-live="polite"></div>
</template>
