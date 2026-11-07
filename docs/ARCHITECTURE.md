# Architecture

## Shape
One container. Hono API plus the built React app. SQLite in /data. Scheduled jobs in-process (croner). Modules register routes, jobs, AI tools and widgets.

## Data model (SQLite via Drizzle)
- garmin_snapshot: kind, date, payload JSON, fetched_at
- workout: garmin_scheduled_id, garmin_workout_id, date, name, sport, duration_s, completed, first_seen, last_seen
- race (from Garmin get_calendar_events, replaced on each sync by event_uuid): event_uuid, title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, first_seen, last_seen
- race_meta (owned by NGtive Split, never overwritten by sync): meta_key, priority (A, B, C), type (road, trail), goal_override_s, notes, updated_at. meta_key is event_uuid when present, otherwise the date plus the normalised title (lower case, punctuation removed, spaces collapsed). Edits are local database writes with no confirm tap, because nothing outside NGtive Split changes.
- proposal, audit_log (see below)
- sync_state: job, last_ok, last_error, consecutive_failures
- briefing: date, text, data JSON, model, tokens
- chat_message: thread, role, content, tool_calls JSON
- ai_usage: ts, feature, model, input_tokens, output_tokens, cost_gbp
- settings: key, value JSON (taper overrides, home coordinates, Phase 5 calendar allowlist)
- secret: name, ciphertext (AES-256-GCM, key from PULSE_SECRET_KEY)

## Auth
Single user. Password checked against a scrypt hash (salt:hash in hex) in PULSE_PASSWORD_HASH. Signed httpOnly SameSite=Lax session cookie (30 days). CSRF token header on every non-GET. Login rate limit: 5 attempts per 15 minutes per IP. Tailscale identity headers are not trusted, because LAN clients can spoof them.

## Proposal engine (the only write path)
- Creators (UI actions and AI tools) call createProposal(). Nothing else may execute a write.
- proposal fields: id, kind (garmin.schedule, garmin.reschedule, garmin.unschedule, calendar.create, calendar.update, ha.call_service), target_system, payload, before, after, rationale, created_by (user or ai), state_hash, status (pending, applied, rejected, expired, stale, failed), expires_at (24 hours), decided_at, result.
- Executors live one file per system and are importable only from the confirm route (enforce with an ESLint no-restricted-imports rule and a test).
- POST /api/proposals/:id/confirm needs a session and CSRF. It requires status pending and not expired, re-fetches live state, compares state_hash, and if it differs marks the proposal stale and shows the new diff. Otherwise it executes, writes audit_log, updates status.
- AI tool context has no reference to executors or the confirm route. ntfy messages link to the app and never carry confirm actions.
- Idempotency (Phase 5): calendar events carry extendedProperties.private.pulseKey. Garmin operations are keyed by scheduled_workout_id.
- audit_log is append only: ts, actor, action, target, payload_hash, result.
- Allowlists: Google Calendar writes do not exist until Phase 5, which will define a writable calendar allowlist (likely the app-created "Pulse Training"). Garmin write tools limited to schedule_workout, reschedule_workout, unschedule_workout. Home Assistant limited to allowlisted entities, and the domains lock, alarm_control_panel, cover and siren cannot be proposed at all in v1.

## Sync
- Each module job writes snapshots. Garmin every 30 minutes with backoff, covering workouts, metrics and the race calendar. Phase 5 adds Google incremental sync with syncToken, full resync on 410.
- UI reads the database only, never live upstream calls per page view.
- ntfy alert after 3 consecutive failures, at most once per day per job.

## Security and ops
- pino logging with token redaction. Secrets only in env or the encrypted secret table.
- Nightly SQLite backup (VACUUM INTO /data/backups, keep 7). Check that existing Restic jobs cover /mnt/data/AppData/pulse.
- Dockerfile: multi-stage on node:22-alpine, non-root, healthcheck on /api/health.
- CI: GitHub Actions on the existing self-hosted runner builds and pushes ghcr.io/mark-130/pulse:latest and :sha. Watchtower pulls updates.
