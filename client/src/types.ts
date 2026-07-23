export interface ServerInfo {
  version?: string
  servername?: string
  serverName?: string
  description?: string
  worldguid?: string
  worldGuid?: string
  [key: string]: unknown
}

export interface ServerMetrics {
  currentplayernum?: number
  currentPlayerNum?: number
  serverfps?: number
  serverFPS?: number
  serverframetime?: number
  uptime?: number
  days?: number
  maxplayernum?: number
  maxPlayerNum?: number
  basecampnum?: number
  [key: string]: unknown
}

export interface Player {
  name?: string
  playerId?: string
  playerid?: string
  userId?: string
  userid?: string
  ip?: string
  ping?: number
  location_x?: number
  location_y?: number
  level?: number
  [key: string]: unknown
}

export interface IniSummary {
  path?: string
  fields?: Record<string, string>
  serverName?: string | null
  maxPlayers?: number | null
}

export interface LogEntry {
  line: string
  ts: number
}

export interface BanEntry {
  userid: string
  name: string | null
  reason: string | null
  ts: number
}

export interface ConfigFile {
  path: string
  content: string
  mtime: number | null
}

export interface ConfigBackup {
  name: string
  size: number
  mtime: number
}

export interface AutostopState {
  enabled: boolean
  delayMinutes: number
  allowedDelayMinutes: number[]
  armed: boolean
  armedAt: number | null
  deadlineAt: number | null
  remainingMs: number | null
  stopping: boolean
  containerRunning: boolean | null
  containerStatus: string | null
  notice?: string | null
}

export interface BasePal {
  instanceId?: string | null
  species: string
  nickName?: string | null
  level: number | null
  hp?: number | null
  fullStomach?: number | null
  sanity?: number | null
  hungerType?: string | null
  physicalHealth?: string | null
  workerSick?: string | null
  workerEvent?: string | null
  passives?: string[]
  isRare?: boolean
  rank?: number | null
  ownerPlayerUid?: string | null
  ownerName?: string | null
  containerId?: string | null
  slotIndex?: number | null
  groupId?: string | null
  status: string
}

export interface BaseResource {
  id: string
  count: number
}

export interface BaseCamp {
  id: string
  name?: string | null
  rawName?: string | null
  nameIsDefault?: boolean
  state?: number | null
  areaRange?: number | null
  groupId?: string | null
  ownerNames: string[]
  ownerPlayerUids: string[]
  location: { x?: number | null; y?: number | null; z?: number | null }
  workerContainerId?: string | null
  palCount: number
  pals: BasePal[]
  resourceCount?: number
  resources?: BaseResource[]
}

export interface MigrationDiff {
  field: string
  detail?: string
  sourceValue?: string
  targetValue?: string
  changeType?: 'added' | 'removed' | 'modified' | 'renamed' | string
  count?: number
}

export interface MigrationEndpoint {
  uid: string
  hex?: string
  instanceId?: string | null
  playersFile?: string
  playersFileExists?: boolean
  inLevel?: boolean
  ownedPalCount?: number
}

export interface MigrationPreview {
  sourceUid?: string
  targetUid?: string
  source?: MigrationEndpoint
  target?: MigrationEndpoint
  diffs?: MigrationDiff[]
  warnings?: string[]
}

export interface MigrationSelftest {
  identical?: boolean
  mode?: string
  firstDiffOffset?: number | null
  sizes?: { original?: number; roundtripped?: number; recompressedSav?: number }
  source?: { levelSav?: string; magic?: string; saveType?: number }
}

export interface MigrationBackup {
  backupId: string
  createdAt?: number | null
  trigger?: string | null
  sourceUid?: string | null
  targetUid?: string | null
  playerFiles?: number
}

export interface MigrationState {
  status: 'idle' | 'busy' | 'ready' | 'error' | string
  phase: 'selftest' | 'preview' | 'apply' | 'rollback' | 'backup' | null
  updatedAt: number | null
  selftest?: MigrationSelftest | null
  preview?: MigrationPreview | null
  lastApply?: {
    backupId: string
    sourceUid: string
    targetUid: string
    promotedAt: number
  } | null
  lastRestore?: { backupId: string; safetyBackupId: string; restoredAt: number } | null
  lastBackup?: { backupId: string; createdAt: number; trigger?: string } | null
  error?: { code?: string; message: string; details?: string | null } | null
}

export interface BasesReport {
  status: 'idle' | 'snapshotting' | 'parsing' | 'ready' | 'error' | 'unavailable' | string
  updatedAt: number | null
  snapshotId?: string | null
  trigger?: string | null
  error?: { code?: string; message: string; details?: string | null } | null
  stats?: {
    baseCount?: number
    playerCount?: number
    palAtBases?: number
    resourceTypesAtBases?: number
  } | null
  players?: Array<{
    playerUid: string
    name?: string | null
    level?: number | null
    groupId?: string | null
  }>
  bases: BaseCamp[]
  world?: Record<string, unknown> | null
  source?: Record<string, unknown> | null
}
