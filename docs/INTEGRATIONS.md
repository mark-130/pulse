# Integrations

## Garmin (through the existing Garmin MCP server)
- MCP client using @modelcontextprotocol/sdk over streamable HTTP. URL from GARMIN_MCP_URL. Prefer the internal Docker network address of the existing garmin-mcp container. Phase 0 discovers it and records it in DECISIONS.md. The public endpoint is garmin-mcp.hurts.cc via Cloudflare Tunnel (a bare curl returning 406 means healthy).
- The Garmin API behind it is unofficial: cache hard, sync every 30 minutes, never fetch live per page view.
- Read tools by feature:
  - Today: get_scheduled_workouts, get_workout_by_id, get_training_readiness, get_morning_training_readiness, get_sleep_summary, get_hrv_data, get_rhr_day, get_body_battery, get_stats
  - Load and trends: get_training_status, get_training_load_balance, get_training_load_trend, get_vo2max_trend, get_running_tolerance_trend, get_endurance_score, get_race_predictions
  - History: get_activities_by_date, get_activity, get_activity_splits, get_activity_hr_in_timezones
  - Races: get_calendar_events (synced by the Phase 1 Garmin job into the race table: title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, event_uuid). The Garmin calendar is read only for NGtive Split.
- Write tools, through proposals only, called only from the Garmin executor (D32). Phase 3 allows reschedule_workout (scheduled_workout_id, calendar_date) and unschedule_workout (scheduled_workout_id). The id is the calendar entry id from get_scheduled_workouts. schedule_workout is not built. Writes are off by default: PULSE_GARMIN_WRITES=on is needed before any call is made, and with it off the confirm flow records a dry run.
- Never used in v1 (not on any allowlist): delete_*, upload_*, push_workout_to_device, create_* workouts, nutrition, weigh-ins.
- Phase 0 lists the server's tools and diffs them against this file. Tool names may drift.
- Verified against the live server on 07/11/2026 (Phase 1): the server returns some upstream failures as plain text, not as a tool error, for example "Error retrieving training load data for ...: Read timed out". Text starting with "No" (no data found) is an empty result. Any other plain text is treated as a failure.
- get_training_load_trend makes one upstream request per day and times out on long ranges, so the sync asks for 42 days. Ranged tools reject more than 90 days. The calendar accepts a two year range. The first sync backfills 180 days of activities (about one minute), later syncs fetch 14 days.
- Store raw tool output in garmin_snapshot and validate with zod when reading.

## Google Calendar (Phase 5, scope to be agreed)
Not used in v1. Races come from the Garmin calendar (D22). Notes kept for when Phase 5 is scoped:
- OAuth 2.0 web client. Publish the consent screen to "In production" (personal use, the unverified warning is expected), because Testing mode refresh tokens expire after 7 days.
- Likely uses: busy time from a personal calendar for the readiness verdict, and mirrored planned workouts on an app-created "Pulse Training" calendar (proposals only, confirm tap). Scopes and calendars to be agreed.
- Redirect URI, primary: https://<host>.<tailnet>.ts.net:8443/api/auth/google/callback via tailscale serve. Confirm at setup that Google accepts ts.net. Fallback: authorise once from a laptop through an SSH tunnel to localhost:8210 using http://localhost:8210/api/auth/google/callback. The token is stored server side either way.

## ntfy (optional)
Off unless NTFY_TOKEN is set (D28). With no token the app never calls ntfy, logs one info line at boot ("ntfy alerts off") and nothing per skipped alert. A failed send (401, 403, network error, 5 second timeout) is caught, logged as one warning without the token or URL, and never fails, delays or backs off a sync. The sync sheet then says "Failure alerts are off. This screen is the only place failures show."
JSON POST to http://192.168.0.10:8090 (root URL), topic homelab-alerts, Bearer token. Notification titles use APP_NAME from packages/shared. Used for: briefing ready, pending proposals, sync failures. Messages link to NGtive Split (code name pulse) and never confirm anything.

## Anthropic API
Official SDK. Models from env, defaults ANTHROPIC_MODEL_SMART=claude-sonnet-5-5 and ANTHROPIC_MODEL_FAST=claude-haiku-5-5 (verify IDs at docs.claude.com before the first call). Dedicated API key with a spend cap.

## Open-Meteo (Phase 4, optional)
No key. Daily and race-week forecast from home coordinates in settings.

## Home Assistant (Phase 6)
WebSocket API with a long-lived token (HA_URL, HA_TOKEN). Read states first. call_service only through proposals, on allowlisted entities.
