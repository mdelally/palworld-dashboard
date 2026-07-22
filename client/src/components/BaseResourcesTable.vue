<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { BaseResource } from '../types'

const props = defineProps<{
  resources: BaseResource[]
}>()

interface Row {
  id: string
  name: string
  count: number
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

function sortIcon(sorted: false | 'asc' | 'desc') {
  if (sorted === 'asc') return 'i-lucide-arrow-up-narrow-wide'
  if (sorted === 'desc') return 'i-lucide-arrow-down-wide-narrow'
  return 'i-lucide-arrow-up-down'
}

const globalFilter = ref('')
const sorting = ref([{ id: 'count', desc: true }])

const rows = computed<Row[]>(() =>
  props.resources.map((r) => ({
    id: r.id,
    name: humanize(r.id),
    count: r.count,
  })),
)

const columns: TableColumn<Row>[] = [
  { accessorKey: 'name', header: 'Item' },
  {
    accessorKey: 'count',
    header: 'Count',
    meta: {
      class: {
        th: 'text-right',
        td: 'text-right tabular-nums font-medium',
      },
    },
  },
]
</script>

<template>
  <div
    v-if="!resources.length"
    class="py-2 text-xs text-muted"
  >
    No resources found in this base’s chests or stations.
  </div>
  <div
    v-else
    class="space-y-2"
  >
    <UInput
      v-model="globalFilter"
      icon="i-lucide-search"
      size="sm"
      placeholder="Filter resources…"
      class="max-w-xs"
    />
    <UTable
      v-model:global-filter="globalFilter"
      v-model:sorting="sorting"
      :data="rows"
      :columns="columns"
      class="shrink-0"
    >
      <template #name-header="{ column }">
        <UButton
          color="neutral"
          variant="ghost"
          label="Item"
          :icon="sortIcon(column.getIsSorted())"
          class="-mx-2.5"
          @click="column.toggleSorting(column.getIsSorted() === 'asc')"
        />
      </template>
      <template #count-header="{ column }">
        <div class="flex justify-end">
          <UButton
            color="neutral"
            variant="ghost"
            label="Count"
            :icon="sortIcon(column.getIsSorted())"
            class="-mx-2.5"
            @click="column.toggleSorting(column.getIsSorted() === 'asc')"
          />
        </div>
      </template>
      <template #count-cell="{ row }">
        ×{{ row.original.count.toLocaleString() }}
      </template>
    </UTable>
  </div>
</template>
