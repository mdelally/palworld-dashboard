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
