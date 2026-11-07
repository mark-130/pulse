# Training model

## Sources of truth
- Workouts: Garmin, via get_scheduled_workouts. A separate plan app pushes into Garmin. Pulse never talks to the plan app.
- Verified 07/11/2026: the plan app's workout appears in get_scheduled_workouts ("1h50 Long Run", 08/11/2026, 110 min). get_garmin_coach_workouts returned nothing, so Coach tools are not the source.
- Horizon: only one workout was visible across the next five weeks, so the plan app appears to push a short rolling window (inference). Pulse snapshots scheduled workouts daily, keeps history, and never assumes future workouts are visible.
- Races: the Google calendar "Running Events" (id 8ef6ff9ee3c4726b6ccc486d13c90ab0d22d1b9bb66cc2339664fb8cc9151e9d@group.calendar.google.com). Garmin calendar events (get_calendar_events) only enrich: start time, goal time, is_race, primary_event.
- Taper advice derives from race dates and recent load, never from future workouts.

## Race identification
- Every event on Running Events is a race. Nothing else goes on that calendar.
- Optional metadata: one line in the event description, for example `@pulse prio=A dist=21.1 goal=1:40:00 type=road`. Keys: prio (A, B, C), dist (km), goal (h:mm:ss), type (road, trail). Other description text (booking references) is preserved untouched.
- Inference when a key is missing: dist from the title (marathon 42.195, half 21.0975, 10K 10); prio B, A if Garmin primary_event is true, C if the matched Garmin event has is_race false; goal from Garmin goal_time_seconds; type trail if the title contains trail or Snowdonia.
- Inferred races appear in an "Unclassified" card. Writing the @pulse line back to Google is a proposal that needs a confirm tap.
- Matching Google to Garmin: same date and distance within 5 percent, then fuzzy title. Report mismatches (races on Google but absent from Garmin) as read-only information. Pulse cannot write to the Garmin calendar.
- All-day events: use Garmin start_time_local when matched, otherwise show "start time unknown".

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
- Inputs: training readiness, sleep score, HRV status against baseline, resting heart rate against baseline, body battery, recent load, today's planned workout, busy time from calendars.
- Output: one of "Go as planned", "Go but easier", "Swap for recovery", "Rest", with reasons that cite numbers and dates.
- Never a diagnosis. Illness, pain or injury: advise rest and seeing a clinician or physio.
- The verdict is advice. Garmin and the plan app keep the real workouts.

## Plan app conflict risk
The plan app may re-push and overwrite a reschedule. Phase 3 includes a sync-conflict probe: Mark confirms a move of one test workout, then reports whether the plan app reverts it. The result is recorded in DECISIONS.md and decides whether reschedule proposals are offered.
