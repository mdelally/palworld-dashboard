---
taskId: 01KY52VHTYBZSVTWAA260HNYCC
title: Autostop idle timer + Start/Stop container
status: in-progress
priority: high
labels:
  - autostop
  - docker
  - backend
  - frontend
order: 1
created: '2026-07-22T14:14:43.806Z'
updated: '2026-07-22T14:14:45.317Z'
---
When the world goes empty, arm a configurable idle timer (30/45/60/120 min). On expiry: save + Docker stop (leave down). Cancel if anyone logs in. Add Start container button for bringing the server back without Unraid.

## Behavior
1. Trigger only on transition to empty world (`players.length` 0←N), while REST reachable.
2. Configurable delay + enable/disable; persist under `/data`.
3. On expiry: best-effort `save()` then `POST /containers/{name}/stop`.
4. Login while armed → cancel timer; only re-arm on next empty transition.
5. `POST /api/start` → Docker start. UI shows Start when container is not running.

## Out of scope here
Logout save snapshots / Phase 3 parse reports (follow-up).

## Acceptance
- [ ] Empty world arms countdown; UI shows remaining time via SSE
- [ ] Join cancels countdown
- [ ] Expiry saves + stops and does not auto-restart
- [ ] Start button brings container back online
- [ ] Settings persist across dashboard restart
