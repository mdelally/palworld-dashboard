<script setup lang="ts">
import { computed, ref } from "vue";
import type { TabsItem } from "@nuxt/ui";
import { useColorMode } from "@vueuse/core";
import {
  FPS_HISTORY_MS,
  formatUptime,
  pickMetric,
  pickServerName,
  useDashboard,
} from "../composables/useDashboard";
import PlayersPanel from "../components/PlayersPanel.vue";
import BansPanel from "../components/BansPanel.vue";
import LogPanel from "../components/LogPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import AutostopPanel from "../components/AutostopPanel.vue";
import BasesPanel from "../components/BasesPanel.vue";
import MigrationPanel from "../components/MigrationPanel.vue";
import ConfigEditorPanel from "../components/ConfigEditorPanel.vue";
import SettingsPanel from "../components/SettingsPanel.vue";
import MetricSparkline from "../components/MetricSparkline.vue";

const dash = useDashboard();

// Admin token entry (only needed when DASHBOARD_TOKEN is set server-side).
const tokenModalOpen = ref(false);
const tokenInput = ref("");
function openTokenModal() {
  tokenInput.value = dash.dashboardToken.value;
  tokenModalOpen.value = true;
}
function saveToken() {
  dash.setDashboardToken(tokenInput.value.trim());
  tokenModalOpen.value = false;
}

const serverName = computed(() => pickServerName(dash.info.value, dash.settingsIni.value));
const fps = computed(() => pickMetric(dash.metrics.value, "serverfps", "serverFPS"));
const fpsSparkPoints = computed(() =>
  dash.fpsHistory.value.map((s) => ({ t: s.t, v: s.fps })),
);
const uptime = computed(() => formatUptime(pickMetric(dash.metrics.value, "uptime", "uptime")));
const playerCount = computed(() => {
  const fromMetrics = pickMetric(dash.metrics.value, "currentplayernum", "currentPlayerNum");
  if (fromMetrics != null) return fromMetrics;
  return dash.players.value.length;
});
const maxPlayers = computed(() => {
  const fromMetrics = pickMetric(dash.metrics.value, "maxplayernum", "maxPlayerNum");
  if (fromMetrics != null) return fromMetrics;
  return dash.settingsIni.value?.maxPlayers ?? null;
});
const version = computed(() => dash.info.value?.version || "—");
const baseCount = computed(() => pickMetric(dash.metrics.value, "basecampnum", "basecampNum"));

const lastUpdated = computed(() => {
  if (!dash.updatedAt.value) return "Waiting…";
  return new Date(dash.updatedAt.value).toLocaleTimeString();
});

const colorMode = useColorMode();
const isDark = computed({
  get: () => colorMode.value === "dark",
  set: (v: boolean) => {
    colorMode.value = v ? "dark" : "light";
  },
});

const containerRunning = computed(() => dash.autostop.value?.containerRunning ?? null);
const serverOnline = computed(() => dash.palworldReachable.value);
const powerDisabled = computed(() => {
  if (serverOnline.value) return containerRunning.value === false;
  return containerRunning.value === true;
});

const stopOpen = ref(false);
const stopConfirmText = ref("");
function requestStop() {
  if (dash.actionBusy.value || powerDisabled.value) return;
  stopConfirmText.value = "";
  stopOpen.value = true;
}
function confirmStop() {
  if (stopConfirmText.value.trim().toUpperCase() !== "STOP") return;
  stopOpen.value = false;
  void dash.stopServer();
}
function onServerPowerClick() {
  if (serverOnline.value) requestStop();
  else void dash.startServer();
}

const activeTab = ref("home");
const tabs: TabsItem[] = [
  { label: "Home", icon: "i-lucide-layout-dashboard", value: "home", slot: "home" },
  { label: "Bans", icon: "i-lucide-ban", value: "bans", slot: "bans" },
  { label: "Controls", icon: "i-lucide-sliders-horizontal", value: "controls", slot: "controls" },
  { label: "Bases", icon: "i-lucide-tent", value: "bases", slot: "bases" },
  { label: "Migration", icon: "i-lucide-arrow-right-left", value: "migration", slot: "migration" },
  { label: "Config", icon: "i-lucide-file-code", value: "config", slot: "config" },
  { label: "Settings", icon: "i-lucide-settings", value: "settings", slot: "settings" },
];
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-[100rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">
          {{ serverName }}
        </h1>
        <p class="mt-1 text-sm text-muted">Live ops dashboard · last update {{ lastUpdated }}</p>
      </div>

      <div class="flex items-center gap-2">
        <UBadge :color="dash.connected.value ? 'success' : 'warning'" variant="subtle" size="lg">
          {{ dash.connected.value ? 'SSE live' : 'SSE reconnecting' }}
        </UBadge>
        <UFieldGroup size="lg">
          <UBadge
            :color="serverOnline ? 'success' : 'error'"
            variant="solid"
            size="lg"
          >
            {{ serverOnline ? 'Server online' : 'Server offline' }}
          </UBadge>
          <UButton
            :color="serverOnline ? 'neutral' : 'success'"
            variant="solid"
            :icon="serverOnline ? 'i-lucide-square' : 'i-lucide-play'"
            :loading="dash.actionBusy.value"
            :disabled="powerDisabled"
            :title="serverOnline ? 'Stop server' : 'Start server'"
            @click="onServerPowerClick"
          >
            {{ serverOnline ? 'Stop' : 'Start' }}
          </UButton>
        </UFieldGroup>
        <UButton
          :icon="dash.dashboardToken.value ? 'i-lucide-lock' : 'i-lucide-lock-open'"
          :color="dash.dashboardToken.value ? 'success' : 'neutral'"
          variant="ghost"
          square
          title="Admin token"
          @click="openTokenModal"
        />
        <UButton
          :icon="isDark ? 'i-lucide-moon' : 'i-lucide-sun'"
          color="neutral"
          variant="ghost"
          square
          @click="isDark = !isDark"
        />
      </div>
    </header>

    <UModal v-model:open="stopOpen" title="Stop the server?">
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            This saves the world (if reachable), then stops the game container and
            leaves it down. Use Start when you want it back.
          </p>
          <p class="text-sm text-muted">
            Type <span class="font-mono font-semibold text-highlighted">STOP</span> to confirm.
          </p>
          <UInput
            v-model="stopConfirmText"
            placeholder="STOP"
            autofocus
            @keyup.enter="confirmStop"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="stopOpen = false">
            Cancel
          </UButton>
          <UButton
            color="neutral"
            icon="i-lucide-square"
            :disabled="stopConfirmText.trim().toUpperCase() !== 'STOP'"
            @click="confirmStop"
          >
            Stop now
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="tokenModalOpen" title="Admin token">
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            Required only when the server sets <span class="font-mono">DASHBOARD_TOKEN</span>.
            Stored in this browser and sent with admin actions (kick, ban, restart…).
          </p>
          <UInput
            v-model="tokenInput"
            type="password"
            placeholder="Paste admin token"
            autofocus
            @keyup.enter="saveToken"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="tokenModalOpen = false">
            Cancel
          </UButton>
          <UButton icon="i-lucide-check" @click="saveToken">Save</UButton>
        </div>
      </template>
    </UModal>

    <UAlert
      v-if="dash.error.value"
      color="error"
      variant="subtle"
      icon="i-lucide-unplug"
      title="Cannot reach Palworld REST API"
      :description="dash.error.value"
    />

    <UAlert
      v-if="dash.notice.value"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      :title="dash.notice.value"
      :close="{ onClick: () => { dash.notice.value = null } }"
    />

    <UTabs
      v-model="activeTab"
      orientation="vertical"
      variant="pill"
      size="md"
      :items="tabs"
      :unmount-on-hide="false"
      class="w-full"
      :ui="{
        root: 'items-start gap-6',
        list: 'w-44 shrink-0',
        trigger: 'w-full justify-start',
        content: 'flex-1 min-w-0 w-full',
      }"
    >
      <template #home>
        <div class="flex flex-col gap-6">
          <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div class="rounded-xl border border-default bg-elevated/60 px-4 py-3 backdrop-blur">
              <p class="text-xs text-muted uppercase">Server</p>
              <p class="mt-1 truncate text-lg font-medium">{{ serverName }}</p>
              <p class="text-xs text-muted">v{{ version }}</p>
            </div>
            <div class="rounded-xl border border-default bg-elevated/60 px-4 py-3 backdrop-blur">
              <p class="text-xs text-muted uppercase">Players</p>
              <p class="mt-1 text-2xl font-semibold tabular-nums">
                {{ playerCount }}
                <span v-if="maxPlayers != null" class="text-base text-muted">
                  / {{ maxPlayers }}</span
                >
              </p>
            </div>
            <div class="rounded-xl border border-default bg-elevated/60 px-4 py-3 backdrop-blur">
              <p class="text-xs text-muted uppercase">FPS</p>
              <p class="mt-1 text-2xl font-semibold tabular-nums">{{ fps ?? '—' }}</p>
              <MetricSparkline
                class="mt-2"
                :points="fpsSparkPoints"
                :window-ms="FPS_HISTORY_MS"
                :y-min="0"
                :y-soft-max="60"
                aria-label="Server FPS over the last 30 minutes"
              />
            </div>
            <div class="rounded-xl border border-default bg-elevated/60 px-4 py-3 backdrop-blur">
              <p class="text-xs text-muted uppercase">Uptime</p>
              <p class="mt-1 text-2xl font-semibold tabular-nums">{{ uptime }}</p>
            </div>
            <div class="rounded-xl border border-default bg-elevated/60 px-4 py-3 backdrop-blur">
              <p class="text-xs text-muted uppercase">Bases</p>
              <p class="mt-1 text-2xl font-semibold tabular-nums">{{ baseCount ?? '—' }}</p>
            </div>
          </section>

          <PlayersPanel
            :players="dash.players.value"
            :busy="dash.actionBusy.value"
            :disabled="!dash.palworldReachable.value"
            @kick="(userid, name) => dash.kickPlayer(userid, name)"
            @ban="(userid, name, reason) => dash.banPlayer(userid, name, reason)"
          />

          <LogPanel
            :logs="dash.logs"
            :paused="dash.logPaused.value"
            @pause="dash.setPaused(true)"
            @resume="dash.setPaused(false)"
            @clear="dash.clearLogs"
          />
        </div>
      </template>

      <template #bans>
        <BansPanel
          :bans="dash.bans.value"
          :busy="dash.actionBusy.value"
          @unban="(userid, name) => dash.unbanPlayer(userid, name)"
        />
      </template>

      <template #controls>
        <div class="flex flex-col gap-6">
          <ActionsPanel
            :busy="dash.actionBusy.value"
            :error="dash.actionError.value"
            :disabled="!dash.palworldReachable.value"
            :container-running="dash.autostop.value?.containerRunning ?? null"
            @announce="dash.announce"
            @save="dash.saveWorld"
            @restart="dash.restartServer"
            @start="dash.startServer"
            @stop="dash.stopServer"
          />
          <AutostopPanel
            :state="dash.autostop.value"
            :busy="dash.actionBusy.value"
            @update="dash.updateAutostop"
            @cancel="dash.cancelAutostop"
          />
        </div>
      </template>

      <template #bases>
        <BasesPanel
          :report="dash.bases.value"
          :busy="dash.actionBusy.value"
          @refresh="dash.refreshBases"
        />
      </template>

      <template #migration>
        <MigrationPanel
          :state="dash.migration.value"
          :players="dash.bases.value?.players"
          :container-running="dash.autostop.value?.containerRunning ?? null"
          :has-token="!!dash.dashboardToken.value"
          :selftest="dash.migrationSelftest"
          :preview="dash.previewMigration"
          :apply="dash.applyMigration"
          :rollback="dash.rollbackMigration"
          :create-backup="dash.createMigrationBackup"
          :load-backups="dash.loadMigrationBackups"
        />
      </template>

      <template #config>
        <ConfigEditorPanel
          :has-token="!!dash.dashboardToken.value"
          :dark="isDark"
          :load="dash.loadConfig"
          :save="dash.saveConfig"
          :list-backups="dash.loadConfigBackups"
          :restore="dash.restoreConfig"
          @restart="dash.restartServer"
        />
      </template>

      <template #settings>
        <SettingsPanel :api="dash.settingsApi.value" :ini="dash.settingsIni.value" />
      </template>
    </UTabs>

    <footer class="pb-4 text-center text-xs text-muted">
      Palworld Dashboard · LAN / Tailscale · admin password never leaves the server
    </footer>
  </div>
</template>
