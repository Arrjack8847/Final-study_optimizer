// api.js
import { db, auth } from "./firebase.js";

import {
  collection,
  addDoc,
  doc,
  getDocs,
  getDoc,
  query,
  where,
  limit,
  writeBatch,
  serverTimestamp,
  updateDoc,
  Timestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

/* =========================================================
   AUTH HELPER
========================================================= */
function requireUser() {
  const u = auth.currentUser;
  if (!u) throw new Error("Not logged in");
  return u;
}

/* =========================================================
   PLANS
========================================================= */

/**
 * Create plan + tasks subcollection + enforce 1 active plan
 * Also stores AI JSON + user input payload (Phase 6B Step A)
 */
export async function createPlan({ title, tasks = [], aiPlan = null, input = null }) {
  const uid = requireUser().uid;

  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw new Error("Title is required");
  if (!Array.isArray(tasks)) throw new Error("Tasks must be an array");

  // deactivate old active plans
  const activeQ = query(
    collection(db, "plans"),
    where("userId", "==", uid),
    where("active", "==", true)
  );
  const activeSnap = await getDocs(activeQ);

  const batch = writeBatch(db);
  activeSnap.forEach((d) => batch.update(d.ref, { active: false }));

  // create new plan doc
  const planRef = await addDoc(collection(db, "plans"), {
    userId: uid,
    title: cleanTitle,
    active: true,
    createdAt: serverTimestamp(),

    // NEW (Step A)
    source: "gemini",
    version: 1,
    input: input || null,
    aiPlan: aiPlan || null,
  });

  // create tasks subcollection
  tasks.forEach((t, i) => {
    const taskTitle = String(t?.title || "").trim();
    if (!taskTitle) return;

    const plannedMinutes = Number.isFinite(Number(t?.plannedMinutes))
      ? Number(t.plannedMinutes)
      : 25;

    const taskRef = doc(collection(db, "plans", planRef.id, "tasks"));
    batch.set(taskRef, {
      title: taskTitle,
      subject: t?.subject ? String(t.subject).trim() : "",
      plannedMinutes,
      done: false,
      order: Number.isFinite(Number(t?.order)) ? Number(t.order) : i,
      createdAt: serverTimestamp(),
      completedAt: null,
    });
  });

  await batch.commit();
  await setActivePlanPointer(planRef.id);
  return { id: planRef.id };
}

/** Ensure only one plan active */
async function setOnlyPlanActive(uid, planId) {
  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("Plan not found");

  // Turn off any other active plans
  const activeQ = query(
    collection(db, "plans"),
    where("userId", "==", uid),
    where("active", "==", true)
  );
  const activeSnap = await getDocs(activeQ);

  const batch = writeBatch(db);
  activeSnap.forEach((d) => batch.update(d.ref, { active: false }));
  batch.update(planRef, { active: true });
  await batch.commit();
  await setActivePlanPointer(planId);
}

/**
 * List plans (latest first)
 * NOTE: no orderBy to avoid composite index hassles
 */
export async function getPlans({ limitCount = 10 } = {}) {
  const uid = requireUser().uid;

  // Ensure active plan exists (self-heal might run here)
  const { plan: activePlan } = await getActivePlan();

  // Fetch a bunch then sort client-side (no index hassle)
  const qPlans = query(
    collection(db, "plans"),
    where("userId", "==", uid),
    limit(Math.max(50, limitCount * 5))
  );

  const snap = await getDocs(qPlans);
  let plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Ensure active plan included
  if (activePlan && !plans.some((p) => p.id === activePlan.id)) {
    plans.push(activePlan);
  }

  // Sort newest first, then active on top
  plans.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || 0;
    const tb = b.createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
  plans.sort((a, b) => Number(!!b.active) - Number(!!a.active));

  return { plans: plans.slice(0, limitCount) };
}

/** Get tasks for a plan (ownership checked) */
export async function getPlanTasks(planId) {
  const uid = requireUser().uid;

  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("Plan not found");
  if (planSnap.data().userId !== uid) throw new Error("Forbidden");

  const qTasks = query(
    collection(db, "plans", planId, "tasks"),
    limit(100)
  );

  const tSnap = await getDocs(qTasks);
  const tasks = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // sort client-side by "order"
  tasks.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  return tasks;
}

/** Get active plan (doc only) */
export async function getActivePlan() {
  const uid = requireUser().uid;

  // 1) Pointer-first (most reliable)
  const activePlanId = await getActivePlanPointer().catch(() => null);

  if (activePlanId) {
    const pref = doc(db, "plans", activePlanId);
    const psnap = await getDoc(pref);
    if (psnap.exists()) {
      const data = psnap.data();
      if (data.userId === uid) {
        // ensure active flag is true (optional heal)
        if (data.active !== true) {
          await setOnlyPlanActive(uid, activePlanId).catch(() => {});
        }
        return { plan: { id: psnap.id, ...data, active: true } };
      }
    }
  }

  // 2) Fallback: old query (in case pointer missing)
  const qActive = query(
    collection(db, "plans"),
    where("userId", "==", uid),
    where("active", "==", true),
    limit(1)
  );

  const snap = await getDocs(qActive);
  if (!snap.empty) {
    const d = snap.docs[0];
    await setActivePlanPointer(d.id).catch(() => {});
    return { plan: { id: d.id, ...d.data() } };
  }

  // 3) Self-heal: pick newest plan and set pointer
  const qAny = query(collection(db, "plans"), where("userId", "==", uid), limit(50));
  const anySnap = await getDocs(qAny);
  if (anySnap.empty) return { plan: null };

  const plans = anySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  plans.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  const newest = plans[0];

  await setOnlyPlanActive(uid, newest.id);
  await setActivePlanPointer(newest.id);

  return { plan: { ...newest, active: true } };
}

/** Get active plan + its tasks */
export async function getActivePlanWithTasks() {
  const { plan } = await getActivePlan();
  if (!plan) return { plan: null, tasks: [] };

  const tasks = await getPlanTasks(plan.id);
  return { plan, tasks };
}

/** Mark a task done/undone (ownership checked via plan) */
export async function setTaskDone(planId, taskId, done) {
  const uid = requireUser().uid;

  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("Plan not found");
  if (planSnap.data().userId !== uid) throw new Error("Forbidden");

  const taskRef = doc(db, "plans", planId, "tasks", taskId);
  await updateDoc(taskRef, {
    done: !!done,
    completedAt: done ? serverTimestamp() : null,
  });
}

/** Used by first-auth.js */
export async function hasActivePlan() {
  const { plan } = await getActivePlan();
  return !!plan;
}

/** Switch active plan (enforce only 1 active) */
export async function setPlanActive(planId) {
  const uid = requireUser().uid;

  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("Plan not found");
  if (planSnap.data().userId !== uid) throw new Error("Forbidden");

  const activeQ = query(
    collection(db, "plans"),
    where("userId", "==", uid),
    where("active", "==", true)
  );
  const activeSnap = await getDocs(activeQ);

  const batch = writeBatch(db);
  activeSnap.forEach((d) => batch.update(d.ref, { active: false }));
  batch.update(planRef, { active: true });

  await batch.commit();
  await setActivePlanPointer(planId);
}

/* =========================================================
   SESSION POINTER (NO DOUBLE SESSIONS)
========================================================= */

function userDocRef(uid) {
  return doc(db, "users", uid);
}

export async function getActiveSessionPointer() {
  const uid = requireUser().uid;
  const snap = await getDoc(userDocRef(uid));
  if (!snap.exists()) return null;

  const d = snap.data() || {};
  if (!d.activeSessionId) return null;

  return {
    sessionId: d.activeSessionId,
    startedAtMs: d.activeSessionStartedAtMs || null,
    mode: d.activeSessionMode || "pomodoro",
  };
}

async function setActivePlanPointer(planId) {
  const uid = requireUser().uid;
  await setDoc(userDocRef(uid), { activePlanId: planId }, { merge: true });
}

async function getActivePlanPointer() {
  const uid = requireUser().uid;
  const snap = await getDoc(userDocRef(uid));
  if (!snap.exists()) return null;
  return snap.data()?.activePlanId || null;
}

async function setActiveSessionPointer({ sessionId, startedAtMs, mode }) {
  const uid = requireUser().uid;

  await setDoc(
    userDocRef(uid),
    {
      activeSessionId: sessionId,
      activeSessionStartedAtMs: startedAtMs || Date.now(),
      activeSessionMode: mode || "pomodoro",
    },
    { merge: true }
  );
}

async function clearActiveSessionPointer() {
  const uid = requireUser().uid;

  await setDoc(
    userDocRef(uid),
    {
      activeSessionId: null,
      activeSessionStartedAtMs: null,
      activeSessionMode: null,
    },
    { merge: true }
  );
}

/* =========================================================
   FOCUS SESSIONS (NO composite indexes)
   Store under: users/{uid}/sessions
========================================================= */

function sessionsColRef(uid) {
  return collection(db, "users", uid, "sessions");
}

/**
 * Start a session.
 * Phase 11 upgrade: store planned/scaled minutes + subject + burnoutScoreAtStart
 */
export async function startSession(
  {
    planId = null,
    taskId = null,
    mode = "pomodoro",

    // NEW (Phase 11)
    plannedMinutes = null,
    scaledMinutes = null,
    subject = null,
    burnoutScoreAtStart = null,
  } = {}
) {
  const uid = requireUser().uid;

  // Reuse running session if exists
  const ptr = await getActiveSessionPointer().catch(() => null);
  if (ptr?.sessionId) {
    const sref = doc(db, "users", uid, "sessions", ptr.sessionId);
    const ssnap = await getDoc(sref);
    if (ssnap.exists() && ssnap.data()?.status === "running") {
      return { id: ptr.sessionId, reused: true };
    }
    await clearActiveSessionPointer().catch(() => {});
  }

  const startedAtMs = Date.now();

  const payload = {
    planId,
    taskId,
    mode,
    startedAt: serverTimestamp(),
    endedAt: null,
    durationMinutes: 0,
    status: "running",
    createdAt: serverTimestamp(),

    // NEW (Phase 11)
    plannedMinutes: plannedMinutes == null ? null : Number(plannedMinutes) || 0,
    scaledMinutes: scaledMinutes == null ? null : Number(scaledMinutes) || 0,
    subject: subject == null ? null : String(subject || ""),
    burnoutScoreAtStart:
      burnoutScoreAtStart == null
        ? null
        : Math.max(0, Math.min(100, Number(burnoutScoreAtStart) || 0)),
  };

  const ref = await addDoc(sessionsColRef(uid), payload);

  await setActiveSessionPointer({ sessionId: ref.id, startedAtMs, mode });

  return { id: ref.id, reused: false };
}

/**
 * End a session.
 * Phase 11 upgrade: store completed boolean + optional burnoutScoreAtEnd
 */
export async function endSession(
  sessionId,
  {
    durationMinutes = 0,
    status = "completed",

    // OPTIONAL NEW (Phase 11)
    burnoutScoreAtEnd = null,
  } = {}
) {
  const uid = requireUser().uid;
  const ref = doc(db, "users", uid, "sessions", sessionId);

  const update = {
    endedAt: serverTimestamp(),
    durationMinutes: Math.max(0, Number(durationMinutes) || 0),
    status,
    completed: status === "completed",
  };

  if (burnoutScoreAtEnd != null) {
    update.burnoutScoreAtEnd = Math.max(0, Math.min(100, Number(burnoutScoreAtEnd) || 0));
  }

  await updateDoc(ref, update);

  await clearActiveSessionPointer().catch(() => {});
}

export async function cancelSession(sessionId) {
  return endSession(sessionId, { durationMinutes: 0, status: "cancelled" });
}

/* =========================================================
   INSIGHTS
========================================================= */

export async function getTodaySessionStats() {
  const uid = requireUser().uid;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

  const qSessions = query(
    sessionsColRef(uid),
    where("startedAt", ">=", Timestamp.fromDate(start)),
    where("startedAt", "<", Timestamp.fromDate(end))
  );

  const snap = await getDocs(qSessions);

  let totalMinutes = 0;
  let sessionsCount = 0;

  snap.forEach((d) => {
    const s = d.data();
    if (s.status !== "completed") return;
    if (s.mode !== "pomodoro") return;

    sessionsCount += 1;
    totalMinutes += Number(s.durationMinutes) || 0;
  });

  return { totalMinutes, sessionsCount };
}

export async function getStreak({ lookbackDays = 45 } = {}) {
  const uid = requireUser().uid;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - lookbackDays, 0, 0, 0, 0);

  const qSessions = query(
    sessionsColRef(uid),
    where("startedAt", ">=", Timestamp.fromDate(start))
  );

  const snap = await getDocs(qSessions);

  const daysWithSessions = new Set();

  snap.forEach((d) => {
    const s = d.data();
    if (s.status !== "completed") return;
    if (s.mode !== "pomodoro") return;

    const ts = s.startedAt;
    if (!ts?.toDate) return;

    const dt = ts.toDate();
    const key = [
      dt.getFullYear(),
      String(dt.getMonth() + 1).padStart(2, "0"),
      String(dt.getDate()).padStart(2, "0"),
    ].join("-");

    daysWithSessions.add(key);
  });

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");

    if (daysWithSessions.has(key)) streak++;
    else break;
  }

  return { streak };
}

export async function getWeeklyStats() {
  const uid = requireUser().uid;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);

  const qSessions = query(
    sessionsColRef(uid),
    where("startedAt", ">=", Timestamp.fromDate(start))
  );

  const snap = await getDocs(qSessions);

  const days = {};
  snap.forEach((d) => {
    const s = d.data();
    if (s.status !== "completed" || s.mode !== "pomodoro") return;

    const dt = s.startedAt?.toDate?.();
    if (!dt) return;

    const key = [
      dt.getFullYear(),
      String(dt.getMonth() + 1).padStart(2, "0"),
      String(dt.getDate()).padStart(2, "0"),
    ].join("-");

    days[key] = (days[key] || 0) + (Number(s.durationMinutes) || 0);
  });

  return days;
}

export async function getSessionsSinceDays(days = 7) {
  const uid = requireUser().uid;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);

  const qSessions = query(
    sessionsColRef(uid),
    where("startedAt", ">=", Timestamp.fromDate(start))
  );

  const snap = await getDocs(qSessions);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function groupFocusMinutesByDay(sessions, days = 7) {
  const now = new Date();

  const keys = [];
  const map = {};

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    keys.push(key);
    map[key] = 0;
  }

  sessions.forEach((s) => {
    if (s.status !== "completed") return;
    if (s.mode !== "pomodoro") return;

    const dt = s.startedAt?.toDate?.();
    if (!dt) return;

    const key = [
      dt.getFullYear(),
      String(dt.getMonth() + 1).padStart(2, "0"),
      String(dt.getDate()).padStart(2, "0"),
    ].join("-");

    if (map[key] != null) map[key] += Number(s.durationMinutes) || 0;
  });

  return { keys, map };
}

/* =========================================================
   AI OPTIMIZATION (Option A: update tasks in same plan)
========================================================= */

export async function optimizeTasksInPlan(planId, updates = []) {
  const uid = requireUser().uid;

  // ownership check
  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("Plan not found");
  if (planSnap.data().userId !== uid) throw new Error("Forbidden");

  if (!Array.isArray(updates) || !updates.length) {
    throw new Error("No updates provided");
  }

  const batch = writeBatch(db);

  updates.forEach((u) => {
    if (!u?.taskId) return;
    const tref = doc(db, "plans", planId, "tasks", u.taskId);
    batch.update(tref, {
      plannedMinutes: Number(u.plannedMinutes) || 25,
      priority: Number(u.priority) || 3,
      order: Number(u.order) || 0,
      note: String(u.note || ""),
      optimizedAt: serverTimestamp(),
    });
  });

  await batch.commit();

  // mark plan as optimized (optional)
  await updateDoc(planRef, { optimizedAt: serverTimestamp() }).catch(() => {});
}

/* =========================================================
   BURNOUT SCORE
========================================================= */

export async function getBurnoutScore() {
  // Uses your existing functions
  const [{ totalMinutes }, { streak }, { plan, tasks }] = await Promise.all([
    getTodaySessionStats(),
    getStreak(),
    getActivePlanWithTasks(),
  ]);

  let score = 0;

  // 1) Energy from active plan input (default 3)
  const energy = Number(plan?.input?.energyLevel ?? 3);
  if (energy <= 2) score += 25;
  else if (energy === 3) score += 10;

  // 2) Completion rate
  const total = tasks?.length || 0;
  const done = (tasks || []).filter((t) => t.done).length;
  const completion = total ? done / total : 1;

  if (completion < 0.4) score += 25;
  else if (completion < 0.7) score += 10;

  // 3) Streak
  if (Number(streak || 0) === 0) score += 20;

  // 4) Overfocus today
  if (Number(totalMinutes || 0) > 180) score += 20;
  else if (Number(totalMinutes || 0) > 120) score += 10;

  // clamp
  score = Math.max(0, Math.min(100, score));

  const status =
    score > 60 ? "Burnout Risk" :
    score > 30 ? "Fatigued" :
    "Healthy";

  return { score, status, energy, completion, totalMinutes, streak };
}

/* =========================================================
   ADVANCED INSIGHTS (Phase 11)
========================================================= */

export async function getAdvancedInsights({ days = 7 } = {}) {
  const uid = requireUser().uid;

  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (days - 1),
    0, 0, 0, 0
  );

  const qSessions = query(
    collection(db, "users", uid, "sessions"),
    where("startedAt", ">=", Timestamp.fromDate(start))
  );

  const snap = await getDocs(qSessions);

  let totalActual = 0;
  let totalPlanned = 0;
  let totalScaled = 0;
  let burnoutValues = [];
  let subjectMap = {};

  snap.forEach((d) => {
    const s = d.data();
    if (s.status !== "completed") return;
    if (s.mode !== "pomodoro") return;

    const actual = Number(s.durationMinutes) || 0;
    const planned = Number(s.plannedMinutes) || 0;
    const scaled = Number(s.scaledMinutes) || 0;

    totalActual += actual;
    totalPlanned += planned;
    totalScaled += scaled;

    if (typeof s.burnoutScoreAtStart === "number") {
      burnoutValues.push(s.burnoutScoreAtStart);
    }

    if (s.subject) {
      subjectMap[s.subject] = (subjectMap[s.subject] || 0) + actual;
    }
  });

  const productivity =
    totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;

  const focusEfficiency =
    totalScaled > 0 ? (totalActual / totalScaled) * 100 : 0;

  const avgBurnout =
    burnoutValues.length > 0
      ? burnoutValues.reduce((a, b) => a + b, 0) / burnoutValues.length
      : 0;

  return {
    totalActual,
    totalPlanned,
    totalScaled,
    productivity: Math.round(productivity),
    focusEfficiency: Math.round(focusEfficiency),
    avgBurnout: Math.round(avgBurnout),
    subjectMap,
  };
}