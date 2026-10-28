// Toggl Track -> Pomodoro sync (webhook receiver).
//
// Mapping:
//   Toggl time entry STARTED  -> Pomodoro starts WORK  (phase=work, running)
//   Toggl time entry STOPPED  -> Pomodoro starts BREAK (phase=break, running)
//
// Writes directly to the Firestore doc `pomodoro/timer`; the web and mobile
// clients render/sync from there. The Admin SDK bypasses Firestore rules.

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

// Shared HMAC secret, also configured on the Toggl subscription. Set with:
//   firebase functions:secrets:set TOGGL_WEBHOOK_SECRET
const TOGGL_WEBHOOK_SECRET = defineSecret("TOGGL_WEBHOOK_SECRET");

const timerRef = () => admin.firestore().doc("pomodoro/timer");

exports.togglWebhook = onRequest(
  {
    region: "europe-west1",
    maxInstances: 2, // hard guardrail against a runaway loop
    secrets: [TOGGL_WEBHOOK_SECRET],
  },
  async (req, res) => {
    const body = req.body || {};

    // 1. Validation handshake: Toggl sends this when (re)validating the
    //    subscription; echo the code back to confirm the endpoint.
    if (body.validation_code) {
      return res.status(200).json({ validation_code: body.validation_code });
    }

    // 2. Verify the HMAC-SHA256 signature over the RAW body.
    const sig = req.get("x-webhook-signature-256") || "";
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", TOGGL_WEBHOOK_SECRET.value())
        .update(req.rawBody)
        .digest("hex");
    const ok =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.status(403).send("bad signature");

    // 3. The subscription already filters to time_entry created/updated, so no
    //    entity re-check here (Toggl names it `model` in the payload, not
    //    `entity`). Just skip deletes.
    const meta = body.metadata || {};
    console.log("event", JSON.stringify({ model: meta.model, action: meta.action,
      entryId: body.payload && body.payload.id, stop: body.payload && body.payload.stop,
      duration: body.payload && body.payload.duration }));
    if (meta.action === "deleted") return res.status(200).send("ignored");

    const entry = body.payload || {};
    // Toggl marks a running entry with stop=null and a negative duration.
    const togglRunning = entry.stop == null && Number(entry.duration) < 0;
    const now = Date.now();

    const snap = await timerRef().get();
    const d = snap.exists ? snap.data() : {};
    const workMins = Number(d.workMins) || 25;
    const breakMins = Number(d.breakMins) || 5;

    if (togglRunning) {
      // STARTED -> work. Ignore mere edits while already working.
      if (d.running === true && d.phase === "work" && d.togglEntryId === entry.id) {
        return res.status(200).send("already working");
      }
      const update = {
        running: true,
        phase: "work",
        endsAt: now + workMins * 60 * 1000,
        togglEntryId: entry.id,
      };
      // Coming off a break -> start a fresh "work since last break" window.
      if (d.phase === "break") update.workedSinceBreak = 0;
      await timerRef().set(update, { merge: true });
      console.log("-> pomodoro WORK started (endsAt in", workMins, "min)");
      return res.status(200).send("work started");
    }

    // STOPPED -> break, but only for the entry we started (avoid reacting to
    // edits of older, already-stopped entries).
    if (entry.id !== d.togglEntryId) {
      console.log("-> ignored stop (not the active entry; active=", d.togglEntryId, ")");
      return res.status(200).send("not the active entry");
    }
    console.log("-> pomodoro BREAK started (endsAt in", breakMins, "min)");
    await timerRef().set(
      {
        running: true,
        phase: "break",
        endsAt: now + breakMins * 60 * 1000,
        togglEntryId: null,
      },
      { merge: true }
    );
    return res.status(200).send("break started");
  }
);
