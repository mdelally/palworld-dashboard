<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { oneDark } from '@codemirror/theme-one-dark'
import type { ConfigBackup, ConfigFile } from '../types'

const props = defineProps<{
  hasToken: boolean
  dark: boolean
  load: () => Promise<ConfigFile>
  save: (content: string) => Promise<{ ok: true; backup: string | null; mtime: number | null }>
  listBackups: () => Promise<{ backups: ConfigBackup[] }>
  restore: (name: string) => Promise<{ ok: true; restored: string; backup: string | null }>
}>()

const emit = defineEmits<{ restart: [] }>()

const editorEl = ref<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const themeCompartment = new Compartment()

const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)
const loaded = ref(false)
const dirty = ref(false)
const filePath = ref<string | null>(null)
const mtime = ref<number | null>(null)

// `baseline` is LF-normalised so dirty-comparison matches the editor doc (which
// CodeMirror stores with LF newlines). `crlf` remembers the file's original
// line ending so we can re-apply it on save and not silently rewrite CRLF→LF.
let baseline = ''
let crlf = false

const backups = ref<ConfigBackup[]>([])
const backupsOpen = ref(false)

const confirmSaveOpen = ref(false)
const confirmRestoreOpen = ref(false)
const restoreTarget = ref<ConfigBackup | null>(null)
const restartOpen = ref(false)
const restartConfirmText = ref('')

function currentText() {
  return view.value ? view.value.state.doc.toString() : ''
}

function themeExt(dark: boolean) {
  return dark ? oneDark : []
}

function buildState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      StreamLanguage.define(properties),
      themeCompartment.of(themeExt(props.dark)),
      EditorView.updateListener.of((v) => {
        if (v.docChanged) dirty.value = currentText() !== baseline
      }),
      EditorView.theme({
        '&': { height: '440px', fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      }),
    ],
  })
}

async function reload() {
  loading.value = true
  error.value = null
  info.value = null
  try {
    const data = await props.load()
    crlf = /\r\n/.test(data.content)
    baseline = data.content.replace(/\r\n/g, '\n')
    filePath.value = data.path
    mtime.value = data.mtime
    view.value?.setState(buildState(baseline))
    loaded.value = true
    dirty.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function requestSave() {
  if (busy.value || !dirty.value) return
  confirmSaveOpen.value = true
}

async function doSave() {
  confirmSaveOpen.value = false
  const text = currentText()
  busy.value = true
  error.value = null
  info.value = null
  try {
    const res = await props.save(crlf ? text.replace(/\n/g, '\r\n') : text)
    baseline = text
    dirty.value = false
    mtime.value = res.mtime
    info.value = res.backup
      ? `Saved. Previous version backed up as ${res.backup}. Restart to apply.`
      : 'Saved. Restart to apply.'
    if (backupsOpen.value) await refreshBackups()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function refreshBackups() {
  try {
    backups.value = (await props.listBackups()).backups
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function toggleBackups() {
  backupsOpen.value = !backupsOpen.value
  if (backupsOpen.value) refreshBackups()
}

function requestRestore(b: ConfigBackup) {
  if (busy.value) return
  restoreTarget.value = b
  confirmRestoreOpen.value = true
}

async function doRestore() {
  const target = restoreTarget.value
  confirmRestoreOpen.value = false
  if (!target) return
  busy.value = true
  error.value = null
  info.value = null
  try {
    const res = await props.restore(target.name)
    await reload()
    await refreshBackups()
    info.value = res.backup
      ? `Restored ${target.name}. Prior config backed up as ${res.backup}. Restart to apply.`
      : `Restored ${target.name}. Restart to apply.`
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function requestRestart() {
  restartConfirmText.value = ''
  restartOpen.value = true
}

function confirmRestart() {
  if (restartConfirmText.value.trim().toUpperCase() !== 'RESTART') return
  restartOpen.value = false
  emit('restart')
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString()
}
function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

watch(
  () => props.dark,
  (dark) => {
    view.value?.dispatch({ effects: themeCompartment.reconfigure(themeExt(dark)) })
  },
)

onMounted(() => {
  if (editorEl.value) {
    view.value = new EditorView({ state: buildState(''), parent: editorEl.value })
  }
  reload()
})

onBeforeUnmount(() => {
  view.value?.destroy()
  view.value = null
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">
            Server config editor
            <UBadge
              v-if="dirty"
              size="sm"
              color="warning"
              variant="subtle"
              class="ml-2 align-middle"
            >
              Unsaved
            </UBadge>
          </h2>
          <p class="truncate text-xs text-muted">
            {{ filePath || 'PalWorldSettings.ini' }}
            <span v-if="mtime"> · modified {{ fmtTime(mtime) }}</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-history"
            :disabled="busy"
            @click="toggleBackups"
          >
            Backups
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="soft"
            icon="i-lucide-rotate-cw"
            :loading="loading"
            :disabled="busy"
            @click="reload"
          >
            Reload
          </UButton>
          <UButton
            size="sm"
            color="primary"
            icon="i-lucide-save"
            :loading="busy"
            :disabled="!dirty || loading"
            @click="requestSave"
          >
            Save
          </UButton>
        </div>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <UAlert
        v-if="!hasToken"
        color="warning"
        variant="subtle"
        icon="i-lucide-shield-alert"
        title="No admin token set"
        description="This editor reads and writes the raw server config (which may contain your admin/server passwords in plaintext). Set an admin token and only use it over a trusted LAN or Tailscale."
      />

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="error"
      />

      <UAlert
        v-else-if="info"
        color="success"
        variant="subtle"
        icon="i-lucide-check"
        :title="info"
      />

      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        title="Changes only take effect after a server restart."
      >
        <template #description>
          A timestamped backup is saved automatically before every write. Use the
          <button
            type="button"
            class="font-medium underline underline-offset-2"
            @click="requestRestart"
          >
            Restart server
          </button>
          action to apply your changes.
        </template>
      </UAlert>

      <div
        ref="editorEl"
        class="overflow-hidden rounded-lg border border-default"
        :class="{ 'opacity-60': loading }"
      />

      <div v-if="backupsOpen" class="rounded-lg border border-default">
        <div class="flex items-center justify-between gap-2 border-b border-default px-3 py-2">
          <p class="text-sm font-medium">Backups</p>
          <UBadge color="neutral" variant="subtle">{{ backups.length }}</UBadge>
        </div>
        <div v-if="backups.length === 0" class="px-3 py-6 text-center text-sm text-muted">
          No backups yet — one is created the first time you save.
        </div>
        <ul v-else class="divide-y divide-default">
          <li
            v-for="b in backups"
            :key="b.name"
            class="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div class="min-w-0">
              <p class="truncate text-sm">{{ fmtTime(b.mtime) }}</p>
              <p class="truncate text-xs text-muted break-all">{{ b.name }} · {{ fmtSize(b.size) }}</p>
            </div>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-undo-2"
              :disabled="busy"
              @click="requestRestore(b)"
            >
              Restore
            </UButton>
          </li>
        </ul>
      </div>
    </div>

    <UModal v-model:open="confirmSaveOpen" title="Save server config?">
      <template #body>
        <p class="text-sm text-muted">
          The current file is backed up first, then overwritten with your edits.
          Changes take effect only after a server restart.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmSaveOpen = false">
            Cancel
          </UButton>
          <UButton color="primary" icon="i-lucide-save" @click="doSave">Save now</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="confirmRestoreOpen" title="Restore this backup?">
      <template #body>
        <p class="text-sm text-muted">
          This overwrites the live config with
          <span class="font-mono text-highlighted">{{ restoreTarget?.name }}</span>.
          The current config is backed up first, so this is reversible. Restart to apply.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmRestoreOpen = false">
            Cancel
          </UButton>
          <UButton color="warning" icon="i-lucide-undo-2" @click="doRestore">Restore</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="restartOpen" title="Restart the server?">
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            This announces a warning, saves the world, waits the grace period, then
            restarts the game container. All players will be disconnected.
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
          <UButton color="neutral" variant="ghost" @click="restartOpen = false">Cancel</UButton>
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
