<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  busy: boolean
  error: string | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  announce: [message: string]
  save: []
  restart: []
}>()

const message = ref('')
const confirmOpen = ref(false)
const restartOpen = ref(false)
const restartConfirmText = ref('')

function submitAnnounce() {
  const text = message.value.trim()
  if (!text || props.busy || props.disabled) return
  emit('announce', text)
  message.value = ''
}

function requestSave() {
  if (props.busy || props.disabled) return
  confirmOpen.value = true
}

function confirmSave() {
  confirmOpen.value = false
  emit('save')
}

function requestRestart() {
  if (props.busy) return
  restartConfirmText.value = ''
  restartOpen.value = true
}

function confirmRestart() {
  if (restartConfirmText.value.trim().toUpperCase() !== 'RESTART') return
  restartOpen.value = false
  emit('restart')
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <h2 class="text-base font-semibold">Admin actions</h2>
        <p class="text-xs text-muted">Broadcast a message or force a world save</p>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="error"
      />

      <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="submitAnnounce">
        <UInput
          v-model="message"
          class="flex-1"
          placeholder="Announcement message…"
          :disabled="busy || disabled"
          maxlength="200"
        />
        <UButton
          type="submit"
          icon="i-lucide-megaphone"
          :loading="busy"
          :disabled="disabled || !message.trim()"
        >
          Announce
        </UButton>
      </form>

      <div class="flex items-center justify-between gap-3 border-t border-default pt-4">
        <p class="text-xs text-muted">
          Save writes the current world to disk on the Palworld host.
        </p>
        <UButton
          color="warning"
          variant="soft"
          icon="i-lucide-save"
          :loading="busy"
          :disabled="disabled"
          @click="requestSave"
        >
          Save world
        </UButton>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-default pt-4">
        <p class="text-xs text-muted">
          Restart announces, saves, then restarts the game container. Works even
          when the server is unreachable.
        </p>
        <UButton
          color="error"
          variant="soft"
          icon="i-lucide-rotate-ccw"
          :loading="busy"
          @click="requestRestart"
        >
          Restart server
        </UButton>
      </div>
    </div>

    <UModal v-model:open="confirmOpen" title="Force world save?">
      <template #body>
        <p class="text-sm text-muted">
          This asks the Palworld server to save the world now. Players stay connected.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmOpen = false">
            Cancel
          </UButton>
          <UButton color="warning" icon="i-lucide-save" @click="confirmSave">
            Save now
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="restartOpen" title="Restart the server?">
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            This announces a warning, saves the world, waits the grace period,
            then restarts the game container. All players will be disconnected.
          </p>
          <p class="text-sm text-muted">
            Type <span class="font-mono font-semibold text-highlighted">RESTART</span> to confirm.
          </p>
          <UInput
            v-model="restartConfirmText"
            placeholder="RESTART"
            autofocus
            @keyup.enter="confirmRestart"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="restartOpen = false">
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-rotate-ccw"
            :disabled="restartConfirmText.trim().toUpperCase() !== 'RESTART'"
            @click="confirmRestart"
          >
            Restart now
          </UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
