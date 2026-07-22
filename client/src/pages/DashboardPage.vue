<script setup lang="ts">
import { computed, ref } from "vue";
import type { TabsItem } from "@nuxt/ui";
import { useColorMode } from "@vueuse/core";
import {
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
import ConfigEditorPanel from "../components/ConfigEditorPanel.vue";
import SettingsPanel from "../components/SettingsPanel.vue";

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

const activeTab = ref("home");
const tabs: TabsItem[] = [
  { label: "Home", icon: "i-lucide-layout-dashboard", value: "home", slot: "home" },
  { label: "Bans", icon: "i-lucide-ban", value: "bans", slot: "bans" },
  { label: "Controls", icon: "i-lucide-sliders-horizontal", value: "controls", slot: "controls" },
  { label: "Bases", icon: "i-lucide-tent", value: "bases", slot: "bases" },
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
        <UBadge
          :color="dash.palworldReachable.value ? 'success' : 'error'"
          variant="solid"
          size="lg"
        >
          {{ dash.palworldReachable.value ? 'Server online' : 'Server offline' }}
        </UBadge>
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
