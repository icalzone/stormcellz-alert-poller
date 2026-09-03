# stormcellz-alert-poller

**RETIRED 2026-09-03.** This workflow's `schedule` trigger is disabled — see
`.github/workflows/poll.yml`'s header for why and for the rollback steps. It is superseded
by the `checkNWSAlerts` Cloud Function in the main StormCellz repo (`functions/index.js`),
which ports the dedup/notify logic below onto a Cloud Scheduler cron plus a Firestore
single-document dedup store, an explicit fetch timeout, and a billing-budget kill switch.
See that repo's `Documentation/planning/MASTER_IMPLEMENTATION_PLAN.md` §9.2 for the full
cost analysis and decision record. Kept here, undeleted, as the rollback path and as the
place the original per-hazard/VTEC/topic-naming logic is documented — the sections below
describe how this repo worked while it was live.

---

Polls the National Weather Service's active-alerts feed every 5 minutes and pushes new
severe weather alerts to [StormCellz](https://github.com/) via Firebase Cloud Messaging
topics. No server, no Firestore, no Cloud Functions — this repo's whole job is to run a
free GitHub Actions job and call the FCM Admin API directly.

## Scheduling: why the job loops instead of relying on cron

GitHub runs `schedule` events on a best-effort basis and heavily deprioritises
high-frequency crons. Measured on this repo, the `*/5 * * * *` schedule actually fired
every **1.7–5.3 hours**. A Severe Thunderstorm Warning typically lasts 30–60 minutes, so
warnings were beginning and expiring between runs and were never pushed at all.

So the cadence no longer depends on the trigger. Each run polls on its own loop every
5 minutes for ~5h40m, then exits before the 6-hour runner cap. The cron is kept only to
keep a run *queued*: with `concurrency.group: nws-poller` and `cancel-in-progress: false`,
GitHub holds at most one pending run and starts it the moment the current one ends, so
coverage is continuous.

Dedup state is committed every 6th poll (~30 min) rather than every poll — committing each
iteration would be ~300 commits/day of a 150KB file. The trade-off is that a cancelled job
can lose up to 30 minutes of state, which re-notifies at most that window's hazards once.

## Why this exists

A previous Firebase-hosted version of this (Cloud Functions + Firestore) got shut down
after an unrelated feature (a persistent WebSocket connection for lightning data) drove up
Cloud Run billing. This repo replaces that architecture entirely: the poll runs on GitHub's
infrastructure (free, unlimited minutes on a public repo), and FCM topic messaging itself
has no usage cap or cost regardless of how many devices are subscribed.

## How it works

1. One HTTP call to `https://api.weather.gov/alerts/active` fetches every active alert in
   the US.
2. Alerts are grouped by a stable hazard key (derived from the NWS VTEC code, so updates to
   the same hazard don't re-notify).
3. New hazards get one FCM push per NWS zone they cover, to the topic `nws_{zone}_{tier}`
   (`tier` is `minor`/`moderate`/`severe`/`extreme`). A device only receives a push if it's
   subscribed to that exact zone+tier topic — the app subscribes to zones for a user's saved
   locations and to every tier at-or-above their chosen alert threshold.
4. Hazards that get cancelled or expire trigger a silent "clear" push so the app can retract
   an already-delivered notification.
5. Which hazards have already been notified on is tracked in `state/seen-hazards.json`,
   committed back to this repo after every run.

## Setup

1. In the Firebase Console for the StormCellz project: **Project Settings → Service
   Accounts → Generate new private key**. This downloads a JSON file.
2. In this repo's GitHub settings: **Settings → Secrets and variables → Actions → New
   repository secret**. Name it `FIREBASE_SERVICE_ACCOUNT`, paste the entire contents of
   the downloaded JSON file as the value.
3. The workflow (`.github/workflows/poll.yml`) runs automatically every 5 minutes. Trigger
   it manually via the Actions tab → "Poll NWS alerts" → "Run workflow" to test.

## Local testing

```
npm install
FIREBASE_SERVICE_ACCOUNT="$(cat path/to/service-account.json)" node poller.js
```

## Notes

- GitHub's cron scheduling is best-effort and can slip by a few minutes under platform
  load — acceptable for a severe-weather feed, worth knowing if you're debugging apparent
  delays.
- `state/seen-hazards.json` is the whole dedup mechanism. If you ever need to force
  re-notification of everything currently active (e.g. after a bug fix), it's safe to
  reset it to `{}`.
