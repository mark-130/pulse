# Training model

## Sources of truth
- Workouts: Garmin, via get_scheduled_workouts. A separate plan app pushes into Garmin. NGtive Split (code name pulse) never talks to the plan app.
- Verified 07/11/2026: the plan app's workout appears in get_scheduled_workouts ("1h50 Long Run", 08/11/2026, 110 min). get_garmin_coach_workouts returned nothing, so Coach tools are not the source.
- Horizon: only one workout was visible across the next five weeks, so the plan app appears to push a short rolling window (inference). NGtive Split snapshots scheduled workouts daily, keeps history, and never assumes future workouts are visible.
- Races: the Garmin calendar, via get_calendar_events, synced by the Phase 1 Garmin job. Stored fields: title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, event_uuid.
- Taper advice derives from race dates and recent load, never from future workouts.

## Race identification
- A race is a Garmin calendar event returned by get_calendar_events. Events with is_race false are kept and treated as C (see inference).
- NGtive Split never writes to the Garmin calendar. New races are added in Garmin Connect and arrive on the next sync.
- Pulse-owned metadata lives in the race_meta table (see docs/ARCHITECTURE.md): priority (A, B, C), type (road, trail), optional goal override, notes. Edits are local database writes and need no confirm tap. Garmin data is never changed by them.
- Inference defaults when race_meta has no value: priority B, A if primary_event is true, C if is_race is false. Distance from distance_m (title inference of marathon 42.195, half 21.0975, 10K 10 only if distance_m is missing, and then marked inferred). Goal from goal_time_seconds. Type trail if the title contains trail or Snowdonia, otherwise road.
- Races with any inferred priority or type appear in an "Unclassified" card until Mark sets them.
- Start times are shown in the race's own time_zone (Sydney, Antwerp), labelled with the zone. If start_time_local is missing (all-day event), show "start time unknown".

## Race data quality checks
- Start time before 05:00 in its own time zone: flag as unverified. Example on 07/11/2026: Antwerp shows 01:30 Europe/Paris.
- No goal time (goal_time_seconds empty and no override): flag.
- Flags are information on the Races screen and in the briefing. They do not block taper advice.
- Note: on 07/11/2026 Robin Hood Half (26/09/2027) was on Mark's Google calendar but not yet in Garmin. Garmin is the source, so it appears only once added in Garmin Connect.

## Priorities
- A: goal race. Full taper, full recovery.
- B: mini taper, trains through partly.
- C: treated as a workout. No taper. Replaces the nearest quality session.

## Taper defaults (editable in settings, advice only, not medical guidance)
- 10K, A: 7 days. Final week at 70 to 80 percent of normal volume. Keep short race pace work. Last hard session 4 to 5 days out. Easy day plus strides the day before.
- 10K, B: 4 days. About 20 percent volume cut. Last hard session 3 to 4 days out.
- Half, A: 10 days. Volume falls to about 75 percent, then about 60 percent. Last long run 8 to 10 days out and shortened. Keep a few race pace reps.
- Half, B: 5 to 7 days. About 25 percent volume cut. Last long run at least 7 days out.
- Marathon, A: 3 weeks. Week minus 3 about 85 percent, minus 2 about 65 percent, race week about 45 percent. Last long run 14 to 16 days out. Keep marathon pace segments.
- Trail half: as the road half, plus no hard downhill sessions in the final 7 days and one extra recovery day afterwards.
- C: no taper.
- Recovery after a race (easy running only): 10K 2 to 3 days, half 5 to 7 days, marathon 10 to 14 days, trail adds 1 to 2 days. No quality sessions until recovery completes.

## Cluster rules
- Cluster: two races 21 days or fewer apart where either is a half marathon or longer. Only one can be A. Ask Mark to set priorities. The earlier race is suggested as C or a controlled effort. The later race's taper takes precedence.
- A race inside the recovery window of an earlier race gets a warning.
- Fixtures from Mark's calendar on 07/11/2026 (tests only, never hard-code): Rhino 10K 14/11/2026 is 6 days after the 08/11 long run. Pierpont Plod half 14/03/2027 is 21 days before Brighton Marathon 04/04/2027. Scottish Half 15/08/2027 is 14 days before Sydney Marathon 29/08/2027. Expected: all three flagged, with a taper start date suggested for each.

## Daily readiness verdict
- Inputs: training readiness, sleep score, HRV status against baseline, resting heart rate against baseline, body battery, recent load, today's planned workout, busy time from calendars (Phase 5, Google Calendar).
- Output: one of "Go as planned", "Go but easier", "Swap for recovery", "Rest", with reasons that cite numbers and dates.
- Never a diagnosis. Illness, pain or injury: advise rest and seeing a clinician or physio.
- The verdict is advice. Garmin and the plan app keep the real workouts.

## Plan app conflict risk
The plan app may re-push and overwrite a reschedule. Phase 3 includes a sync-conflict probe: Mark confirms a move of one test workout, then reports whether the plan app reverts it. The result is recorded in DECISIONS.md and decides whether reschedule proposals are offered.
