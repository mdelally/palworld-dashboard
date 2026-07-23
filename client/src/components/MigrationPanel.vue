<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { BasesReport, MigrationBackup, MigrationState } from '../types'

const props = defineProps<{
  state: MigrationState | null
  players?: BasesReport['players']
  containerRunning?: boolean | null
  hasToken?: boolean
  selftest: (mode?: 'migrate' | 'full') => Promise<unknown>
  preview: (sourceUid: string, targetUid: string) => Promise<unknown>
  apply: (sourceUid: string, targetUid: string) => Promise<unknown>
  rollback: (backupId: string) => Promise<unknown>
  createBackup: () => Promise<unknown>
  loadBackups: () => Promise<{ backups: MigrationBackup[] }>
}>()

const busy = ref(false)
const busyAction = ref<string | null>(null)
const localError = ref<string | null>(null)
const confirmText = ref('')

const sourceSel = ref<unknown>(null)
const targetSel = ref<unknown>(null)

function selUid(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'value' in v) return String((v as { value: unknown }).value ?? '')
  return ''
}
const sourceUid = computed(() => selUid(sourceSel.value))
const targetUid = computed(() => selUid(targetSel.value))

const playerOptions = computed(() =>
  (props.players ?? []).map((p) => ({
    label: `${p.name ?? 'Unknown'} · ${p.playerUid.slice(0, 8)}${p.level != null ? ` · Lv ${p.level}` : ''}`,
    value: p.playerUid,
  })),
)

const serverStopped = computed(() => props.containerRunning === false)
const selftest = computed(() => props.state?.selftest ?? null)
const selftestPassed = computed(() => selftest.value?.identical === true)
const preview = computed(() => props.state?.preview ?? null)
const lastApply = computed(() => props.state?.lastApply ?? null)
const backupId = computed(() => lastApply.value?.backupId ?? null)

const canPreview = computed(
  () => !!sourceUid.value && !!targetUid.value && sourceUid.value !== targetUid.value,
)
const canApply = computed(
  () =>
    canPreview.value &&
    selftestPassed.value &&
    serverStopped.value &&
    !!preview.value &&
    confirmText.value.trim().toUpperCase() === 'MIGRATE',
)

const statusBadge = computed(() => {
  const s = props.state
  if (!s || s.status === 'idle') return { color: 'neutral' as const, label: 'Idle' }
  if (s.status === 'busy') return { color: 'warning' as const, label: `${s.phase ?? 'working'}…` }
  if (s.status === 'error') return { color: 'error' as const, label: 'Error' }
  return { color: 'success' as const, label: `${s.phase ?? 'ready'} ✓` }
})

async function run(action: string, fn: () => Promise<unknown>) {
  busy.value = true
  busyAction.value = action
  localError.value = null
  try {
    await fn()
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    busyAction.value = null
  }
}

function runSelftest() {
  run('selftest', () => props.selftest('migrate'))
}
function runPreview() {
  if (!canPreview.value) return
  run('preview', () => props.preview(sourceUid.value, targetUid.value))
}
function runApply() {
  if (!canApply.value) return
  run('apply', async () => {
    await props.apply(sourceUid.value, targetUid.value)
    await reloadBackups()
  })
}
function runRollback() {
  if (!backupId.value) return
  run('rollback', async () => {
    await props.rollback(backupId.value as string)
    await reloadBackups()
  })
}

// --- Backups & restore (durable, disk-backed) -----------------------------
const backups = ref<MigrationBackup[]>([])
async function reloadBackups() {
  try {
    backups.value = (await props.loadBackups()).backups ?? []
  } catch {
    // leave the last-known list on a transient failure
  }
}
onMounted(reloadBackups)

function runCreateBackup() {
  run('backup', async () => {
    await props.createBackup()
    await reloadBackups()
  })
}

const restoreTarget = ref<MigrationBackup | null>(null)
const restoreConfirm = ref('')
const restoreOpen = computed({
  get: () => restoreTarget.value !== null,
  set: (v: boolean) => {
    if (!v) restoreTarget.value = null
  },
})
function askRestore(b: MigrationBackup) {
  restoreConfirm.value = ''
  restoreTarget.value = b
}
const canRestore = computed(
  () =>
    !!restoreTarget.value &&
    serverStopped.value &&
    restoreConfirm.value.trim().toUpperCase() === 'RESTORE',
)
function confirmRestore() {
  if (!canRestore.value || !restoreTarget.value) return
  const id = restoreTarget.value.backupId
  restoreTarget.value = null
  run('rollback', async () => {
    await props.rollback(id)
    await reloadBackups()
  })
}

function backupWhen(b: MigrationBackup) {
  return b.createdAt ? new Date(b.createdAt).toLocaleString() : b.backupId
}
function backupKind(b: MigrationBackup) {
  switch (b.trigger) {
    case 'pre-migration':
      return 'before migration'
    case 'pre-restore':
      return 'before a restore'
    case 'manual':
      return 'manual'
    default:
      return b.trigger || 'backup'
  }
}

function fmtBytes(n?: number) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold">Save migration</h2>
          <p class="text-xs text-muted">
            Re-point a player from one PlayerUId to another (e.g. Xbox → Steam). Backed up,
            validated, and reversible — the game server must be stopped to apply.
          </p>
        </div>
        <UBadge :color="statusBadge.color" variant="subtle">{{ statusBadge.label }}</UBadge>
      </div>
    </template>

    <div class="flex flex-col gap-5">
      <UAlert
        v-if="!hasToken"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="Admin token required"
        description="Migration actions are token-guarded. Set the admin token (lock icon, top-right) first."
      />

      <UAlert
        v-if="localError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Action failed"
        :description="localError"
        :close="{ onClick: () => { localError = null } }"
      />
      <UAlert
        v-else-if="state?.error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="state.error.message"
        :description="state.error.code || undefined"
      />

      <!-- Step 1: write-path self-test (the go/no-go gate) -->
      <section class="rounded-xl border border-default bg-elevated/40 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold text-highlighted">1 · Write-path self-test</h3>
            <p class="text-xs text-muted">
              Proves this save round-trips byte-identical before any real write. Safe to run
              anytime (works on a copy).
            </p>
          </div>
          <UButton
            icon="i-lucide-shield-check"
            color="neutral"
            variant="soft"
            size="sm"
            :loading="busy && busyAction === 'selftest'"
            :disabled="busy"
            @click="runSelftest"
          >
            Run self-test
          </UButton>
        </div>
        <div v-if="selftest" class="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <UBadge :color="selftestPassed ? 'success' : 'error'" variant="subtle">
            {{ selftestPassed ? 'Byte-identical ✓' : 'NOT identical — do not migrate' }}
          </UBadge>
          <span class="text-muted">mode: {{ selftest.mode }}</span>
          <span class="text-muted">GVAS: {{ fmtBytes(selftest.sizes?.original) }}</span>
          <span v-if="!selftestPassed && selftest.firstDiffOffset != null" class="text-muted">
            first diff @ byte {{ selftest.firstDiffOffset }}
          </span>
        </div>
      </section>

      <!-- Step 2: choose players + preview -->
      <section class="rounded-xl border border-default bg-elevated/40 p-4">
        <h3 class="text-sm font-semibold text-highlighted">2 · Choose players &amp; preview</h3>
        <p class="text-xs text-muted">
          Source = the character with progress. Target = the identity that inherits it (its current
          character is overwritten).
        </p>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-xs text-muted">Source (from)</label>
            <USelectMenu
              v-model="sourceSel"
              :items="playerOptions"
              placeholder="Select source player"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-muted">Target (to)</label>
            <USelectMenu
              v-model="targetSel"
              :items="playerOptions"
              placeholder="Select target player"
              searchable
            />
          </div>
        </div>
        <div class="mt-3">
          <UButton
            icon="i-lucide-diff"
            color="neutral"
            variant="soft"
            size="sm"
            :loading="busy && busyAction === 'preview'"
            :disabled="busy || !canPreview"
            @click="runPreview"
          >
            Preview changes
          </UButton>
          <span v-if="!canPreview && (sourceUid || targetUid)" class="ml-2 text-xs text-muted">
            Pick two different players.
          </span>
        </div>

        <div v-if="preview" class="mt-4 flex flex-col gap-3">
          <div class="grid gap-2 text-xs sm:grid-cols-2">
            <div class="rounded-lg border border-default p-2">
              <p class="font-semibold text-highlighted">Source</p>
              <p class="text-muted">{{ preview.source?.uid }}</p>
              <p class="text-muted">
                pals owned: {{ preview.source?.ownedPalCount ?? 0 }} ·
                file: {{ preview.source?.playersFileExists ? 'present' : 'missing' }}
              </p>
            </div>
            <div class="rounded-lg border border-default p-2">
              <p class="font-semibold text-highlighted">Target</p>
              <p class="text-muted">{{ preview.target?.uid }}</p>
              <p class="text-muted">
                in save: {{ preview.target?.inLevel ? 'yes' : 'no' }} ·
                file: {{ preview.target?.playersFileExists ? 'present' : 'missing' }}
              </p>
            </div>
          </div>

          <table class="w-full text-left text-sm">
            <thead class="text-xs text-muted">
              <tr class="border-b border-default">
                <th class="py-1 pr-2 font-medium">Change</th>
                <th class="py-1 pr-2 font-medium">Detail</th>
                <th class="py-1 pl-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in preview.diffs" :key="i" class="border-b border-default/60">
                <td class="py-1 pr-2 text-highlighted">{{ d.field }}</td>
                <td class="py-1 pr-2 text-muted">{{ d.detail }}</td>
                <td class="py-1 pl-2 text-right tabular-nums">{{ d.count ?? '—' }}</td>
              </tr>
            </tbody>
          </table>

          <UAlert
            v-for="(w, i) in preview.warnings"
            :key="`w-${i}`"
            color="warning"
            variant="subtle"
            icon="i-lucide-alert-triangle"
            :title="w"
          />
        </div>
      </section>

      <!-- Step 3: apply -->
      <section class="rounded-xl border border-default bg-elevated/40 p-4">
        <h3 class="text-sm font-semibold text-highlighted">3 · Apply</h3>
        <ul class="mt-2 space-y-1 text-xs">
          <li :class="selftestPassed ? 'text-success' : 'text-muted'">
            {{ selftestPassed ? '✓' : '○' }} write-path self-test passed
          </li>
          <li :class="serverStopped ? 'text-success' : 'text-error'">
            {{ serverStopped ? '✓' : '✕' }} game server stopped
            <span v-if="!serverStopped" class="text-muted">(stop it from the header first)</span>
          </li>
          <li :class="preview ? 'text-success' : 'text-muted'">
            {{ preview ? '✓' : '○' }} changes previewed
          </li>
        </ul>
        <p class="mt-3 text-xs text-muted">
          Applying takes a backup, migrates a copy, re-parses it to confirm it loads, then promotes
          it. Type <span class="font-mono font-semibold text-highlighted">MIGRATE</span> to confirm.
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <UInput
            v-model="confirmText"
            placeholder="MIGRATE"
            class="w-40"
            :disabled="!serverStopped || !preview"
          />
          <UButton
            icon="i-lucide-arrow-right-left"
            color="error"
            :loading="busy && busyAction === 'apply'"
            :disabled="busy || !canApply"
            @click="runApply"
          >
            Apply migration
          </UButton>
        </div>

        <div v-if="lastApply" class="mt-4 rounded-lg border border-default p-3 text-xs">
          <p class="font-semibold text-success">Migration applied</p>
          <p class="text-muted">
            {{ lastApply.sourceUid }} → {{ lastApply.targetUid }}
          </p>
          <p class="text-muted">backup: <span class="font-mono">{{ lastApply.backupId }}</span></p>
          <UButton
            class="mt-2"
            icon="i-lucide-undo-2"
            color="neutral"
            variant="soft"
            size="xs"
            :loading="busy && busyAction === 'rollback'"
            :disabled="busy || !serverStopped"
            @click="runRollback"
          >
            Roll back this migration
          </UButton>
          <span v-if="!serverStopped" class="ml-2 text-muted">(stop the server to roll back)</span>
        </div>
      </section>

      <!-- Backups & restore — durable, independent of any migration session -->
      <section class="rounded-xl border border-default bg-elevated/40 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold text-highlighted">Backups &amp; restore</h3>
            <p class="text-xs text-muted">
              A full-world backup is taken automatically before every migration and before every
              restore. Restore replaces the entire world with a backup (server stopped) — a safety
              copy of the current save is taken first, so a restore is itself reversible.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              size="xs"
              square
              title="Refresh backups"
              :loading="busy && busyAction === 'backup'"
              @click="reloadBackups"
            />
            <UButton
              icon="i-lucide-save"
              color="neutral"
              variant="soft"
              size="sm"
              :loading="busy && busyAction === 'backup'"
              :disabled="busy"
              @click="runCreateBackup"
            >
              Create backup now
            </UButton>
          </div>
        </div>

        <p v-if="!backups.length" class="mt-3 text-xs text-muted">
          No backups yet. One will be created automatically when you apply a migration.
        </p>
        <ul v-else class="mt-3 flex flex-col divide-y divide-default/60">
          <li
            v-for="b in backups"
            :key="b.backupId"
            class="flex items-center justify-between gap-3 py-2"
          >
            <div class="min-w-0">
              <p class="truncate text-sm text-highlighted">{{ backupWhen(b) }}</p>
              <p class="truncate text-xs text-muted">
                {{ backupKind(b) }}
                <span v-if="b.sourceUid"> · {{ b.sourceUid.slice(0, 8) }} → {{ b.targetUid?.slice(0, 8) }}</span>
                · {{ b.playerFiles ?? 0 }} player files
              </p>
            </div>
            <UButton
              icon="i-lucide-history"
              color="neutral"
              variant="soft"
              size="xs"
              :disabled="busy || !serverStopped"
              :title="serverStopped ? 'Restore this backup' : 'Stop the server to restore'"
              @click="askRestore(b)"
            >
              Restore
            </UButton>
          </li>
        </ul>
        <p v-if="backups.length && !serverStopped" class="mt-2 text-xs text-muted">
          Stop the game server to enable restore.
        </p>
      </section>
    </div>
  </UCard>

  <UModal v-model:open="restoreOpen" title="Restore this backup?">
    <template #body>
      <div class="flex flex-col gap-3">
        <p class="text-sm text-muted">
          This replaces the <span class="font-semibold text-highlighted">entire world</span> with the
          backup from
          <span class="font-semibold text-highlighted">{{ restoreTarget ? backupWhen(restoreTarget) : '' }}</span>.
          Any progress since then is lost. A safety copy of the current save is taken first, so you
          can undo this.
        </p>
        <p class="text-sm text-muted">
          Type <span class="font-mono font-semibold text-highlighted">RESTORE</span> to confirm.
        </p>
        <UInput v-model="restoreConfirm" placeholder="RESTORE" autofocus @keyup.enter="confirmRestore" />
        <UAlert
          v-if="!serverStopped"
          color="warning"
          variant="subtle"
          icon="i-lucide-alert-triangle"
          title="Game server must be stopped to restore"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="restoreTarget = null">Cancel</UButton>
        <UButton
          color="error"
          icon="i-lucide-history"
          :disabled="!canRestore"
          @click="confirmRestore"
        >
          Restore
        </UButton>
      </div>
    </template>
  </UModal>
</template>
