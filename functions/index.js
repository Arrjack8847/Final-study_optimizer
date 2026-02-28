const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");

admin.initializeApp();
const db = admin.firestore();

const api = express();
api.use(express.json());

api.get("/health", (req, res) => res.send("OK"));

async function verifyFirebaseIdToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).send("Missing token");

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).send("Invalid token");
  }
}

/* ---------------------------
   PLANS
---------------------------- */

api.post("/plans", verifyFirebaseIdToken, async (req, res) => {
  const { title, tasks = [] } = req.body || {};
  if (!title || String(title).trim() === "") {
    return res.status(400).json({ error: "Title required" });
  }

 const uid = req.user.uid;
const ref = await db.collection("users").doc(uid).collection("sessions").add({
  planId,
  taskId,
  mode,
  status: "running",
  startedAt: admin.firestore.FieldValue.serverTimestamp(),
  endedAt: null,
  durationMinutes: 0,
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
});

  return res.json({ id: ref.id });
});

api.get("/plans", verifyFirebaseIdToken, async (req, res) => {
  const snap = await db
    .collection("plans")
    .where("uid", "==", req.user.uid)
    .orderBy("createdAt", "desc")
    .get();

  const plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return res.json({ plans });
});

// Latest plan + tasks (no indexes headache)
api.get("/plans/active", verifyFirebaseIdToken, async (req, res) => {
  const snap = await db
    .collection("plans")
    .where("uid", "==", req.user.uid)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) return res.json({ plan: null, tasks: [] });

  const doc = snap.docs[0];
  const plan = { id: doc.id, ...doc.data() };

  // tasks stored as array of strings -> convert to objects
  const tasks = Array.isArray(plan.tasks)
    ? plan.tasks.map((title, idx) => ({ id: String(idx), title, done: false }))
    : [];

  return res.json({ plan, tasks });
});

/* ---------------------------
   SESSIONS
---------------------------- */

api.post("/sessions/start", verifyFirebaseIdToken, async (req, res) => {
  const { planId = null, taskId = null, mode = "pomodoro" } = req.body || {};

  const ref = await db.collection("sessions").add({
    uid: req.user.uid,
    planId,
    taskId,
    mode, // "pomodoro" | "short" | "long"
    status: "running", // "running" | "completed" | "cancelled"
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    endedAt: null,
    durationMinutes: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return res.json({ id: ref.id });
});

api.post("/sessions/end", verifyFirebaseIdToken, async (req, res) => {
  const { sessionId, durationMinutes = null, status = "completed" } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const uid = req.user.uid;
await db.collection("users").doc(uid).collection("sessions").doc(sessionId).update({
  status,
  durationMinutes: Number(durationMinutes) || 0,
  endedAt: admin.firestore.FieldValue.serverTimestamp(),
});
  return res.json({ ok: true });
});

api.post("/sessions/cancel", verifyFirebaseIdToken, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const uid = req.user.uid;
await db.collection("users").doc(uid).collection("sessions").doc(sessionId).update({
  status: "cancelled",
  endedAt: admin.firestore.FieldValue.serverTimestamp(),
});

  return res.json({ ok: true });
});

/* ---------------------------
   HOME STATS (NO COMPOSITE INDEX)
   We fetch recent sessions and filter in code.
---------------------------- */

api.get("/sessions/stats/today", verifyFirebaseIdToken, async (req, res) => {
  // Malaysia timezone offset is +08:00, but client-side “today” is ok.
  // Here we calculate “today” in server local time; good enough for project.
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const snap = await db
    .collection("sessions")
    .where("uid", "==", req.user.uid)
    .orderBy("startedAt", "desc")
    .limit(250)
    .get();

  let totalMinutes = 0;
  let sessionsCount = 0;

  for (const d of snap.docs) {
    const s = d.data();

    if (s.status !== "completed") continue;
    if (s.mode !== "pomodoro") continue;

    const startedAt = s.startedAt?.toDate?.();
    if (!startedAt) continue;

    if (startedAt >= start && startedAt < end) {
      sessionsCount++;
      const mins = Number(s.durationMinutes || 0);
      if (Number.isFinite(mins)) totalMinutes += mins;
    }
  }

  return res.json({ totalMinutes, sessionsCount });
});

api.get("/sessions/streak", verifyFirebaseIdToken, async (req, res) => {
  const snap = await db
    .collection("sessions")
    .where("uid", "==", req.user.uid)
    .orderBy("startedAt", "desc")
    .limit(500)
    .get();

  // Build set of YYYY-MM-DD dates that have >=1 completed pomodoro
  const days = new Set();

  for (const d of snap.docs) {
    const s = d.data();
    if (s.status !== "completed") continue;
    if (s.mode !== "pomodoro") continue;

    const dt = s.startedAt?.toDate?.();
    if (!dt) continue;

    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
      dt.getDate()
    ).padStart(2, "0")}`;
    days.add(key);
  }

  // Calculate streak from today backwards
  let streak = 0;
  const today = new Date();
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  while (true) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
      cursor.getDate()
    ).padStart(2, "0")}`;

    if (!days.has(key)) break;

    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return res.json({ streak });
});

/* ---------------------------
   mount api under /api
---------------------------- */

const app = express();
app.use("/api", api);

exports.api = functions.https.onRequest(app);