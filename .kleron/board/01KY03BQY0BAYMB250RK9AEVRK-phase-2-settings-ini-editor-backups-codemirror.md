---
taskId: 01KY03BQY0BAYMB250RK9AEVRK
title: Phase 2 — Settings .ini editor + backups (CodeMirror)
status: in-progress
priority: medium
labels:
  - phase-2
  - settings
  - filesystem
  - backend
  - frontend
dependsOn:
  - 01KY03B3PTFGTN93RJBJHR8TZQ
effort: high
order: 0
created: '2026-07-20T15:47:22.176Z'
updated: '2026-07-20T21:10:16.672Z'
---
Let admins view/edit `PalWorldSettings.ini` from the dashboard, with a timestamped backup taken before every write. Editor via CodeMirror.

## Context for a fresh agent
- The ini file is already bind-mounted into the container at `config.palworld.configPath` (`/data/PalWorldSettings.ini`), currently **read-only** (`:ro`) in both compose files. `server/ini.js` (`readIniSummary()`) already reads it for the summary shown in `SettingsPanel.vue`.
- Server = Fastify (`server/routes.js`, token-guarded mutating routes return `{ ok: true }`). Client = Vue 3 + Nuxt UI; settings currently render in `client/src/components/SettingsPanel.vue`.

## Scope
1. **Mount** — change the config bind mount from `:ro` to `:rw` in `docker-compose.yml` and `docker-compose.portainer.yml`. Note in the compose comment that write access is required for the editor.
2. **Backend routes** (token-guarded):
   - `GET /api/config` → raw ini text + mtime.
   - `PUT /api/config` → validate it parses as ini, **write a backup first** to `PalWorldSettings.ini.bak.<ISO-timestamp>` alongside the file, then write the new content. Return the backup path.
   - `GET /api/config/backups` and `POST /api/config/restore` (pick a backup to restore — also backs up current before overwriting).
3. **Frontend** — CodeMirror editor (`codemirror` 6 + an ini/properties mode or generic) in a new panel or a tab in SettingsPanel. Load current text, edit, Save (confirm modal), show backup list with restore. Reuse the shared token-aware fetch helper from Phase 1.
4. **UX copy** — make explicit that **changes only take effect after a server restart** (link to the Phase 1 restart action).

## Gotchas
- Container runs as `USER node` (non-root). The mounted ini and its directory must be writable by that uid, or writes/backup-creation fail with EPERM. Backups are written into the mounted dir, so the **directory** needs write perms, not just the file — call this out in deploy notes and consider mounting the whole `Config/LinuxServer` dir rather than the single file.
- Preserve CRLF/formatting where practical; at minimum don't corrupt the file — validate before writing and never write a zero-byte file.
- Do NOT expose this without `DASHBOARD_TOKEN` set — it's arbitrary server config write access.

## Acceptance criteria
- [ ] Editor loads current `PalWorldSettings.ini` contents.
- [ ] Saving writes the file and creates a timestamped `.bak.<ts>` first.
- [ ] Backup list shows prior saves; restore works and itself backs up first.
- [ ] Invalid/unparseable content is rejected without touching the live file.
- [ ] UI states clearly that a restart is needed to apply.

See [[mvp-working-spec]]. Depends on the shared token fetch helper from [[Phase 1 — REST admin actions: ban / kick / unban + restart]] (and pairs well with its restart action).
