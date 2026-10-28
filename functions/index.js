// Toggl 2.0 (Focus) -> Pomodoro sync by POLLING.
//
// Toggl 2.0 has no webhooks, so a scheduled function polls the current running
// time entry every few minutes and drives the Firestore doc `pomodoro/timer`:
//   Toggl timer running  -> Pomodoro WORK  (phase=work)
//   Toggl timer stopped  -> Pomodoro BREAK (phase=break)
//
// Endpoint: GET /organizations/{org}/workspaces/{ws}/tracking/current
//   200 = a TimeEntry is running; 204 = nothing running.
// Auth: Bearer with the Toggl 2.0 personal key (toggl_sk_...).
//
// Latency is the poll interval (~3 min) — Toggl 2.0 offers no real-time push.
// Interval kept under Toggl's free API limit (~30 req/h), shared with other
// automations on the same key.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

// Toggl 2.0 personal API key (toggl_sk_...). Set with:
//   firebase functions:secrets:set TOGGL_FOCUS_TOKEN
const TOGGL_FOCUS_TOKEN = defineSecret("TOGGL_FOCUS_TOKEN");

const ORG_ID = "6684157";
const WS_ID = "6711899";
const timerRef = () => admin.firestore().doc("pomodoro/timer");

exports.togglPoll = onSchedule(
  {
    schedule: "every 3 minutes",
    region: "europe-west1",
    maxInstances: 1,
    secrets: [TOGGL_FOCUS_TOKEN],
  },
  async () => {
    const url =
      `https://focus.toggl.com/api/organizations/${ORG_ID}` +
      `/workspaces/${WS_ID}/tracking/current`;

    let resp;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${TOGGL_FOCUS_TOKEN.value()}` },
      });
    } catch (e) {
      console.error("toggl fetch failed:", e.message);
      return;
    }

    if (resp.status === 429) {
      console.warn("toggl rate limited (429) — skipping this poll");
      return;
    }

    let runningId = null;
    let runningType = null;
    if (resp.status === 200) {
      const entry = await resp.json().catch(() => null);
      if (entry && entry.id != null) {
        runningId = entry.id;
        runningType = entry.type;
      }
    } else if (resp.status === 204) {
      runningId = null; // not tracking anything
    } else {
      const txt = await resp.text().catch(() => "");
      console.error("toggl tracking/current:", resp.status, txt.slice(0, 200));
      return;
    }

    const snap = await timerRef().get();
    const d = snap.exists ? snap.data() : {};
    const lastId = d.togglEntryId != null ? d.togglEntryId : null;
    const now = Date.now();
    const workMins = Number(d.workMins) || 25;
    const breakMins = Number(d.breakMins) || 5;

    if (runningId != null && String(runningId) !== String(lastId)) {
      // A (new) timer is running in Toggl -> Pomodoro work.
      const update = {
        running: true,
        phase: "work",
        endsAt: now + workMins * 60 * 1000,
        togglEntryId: runningId,
      };
      if (d.phase === "break") update.workedSinceBreak = 0;
      await timerRef().set(update, { merge: true });
      console.log("-> WORK started (toggl entry", runningId, "type", runningType, ")");
    } else if (runningId == null && lastId != null) {
      // Toggl timer stopped -> Pomodoro break.
      await timerRef().set(
        {
          running: true,
          phase: "break",
          endsAt: now + breakMins * 60 * 1000,
          togglEntryId: null,
        },
        { merge: true }
      );
      console.log("-> BREAK started (toggl stopped)");
    } else {
      console.log("no change (runningId", runningId, "lastId", lastId, ")");
    }
  }
);
