import { auth } from "./firebase.js";

/* =========================================
   PRODUCTION AI SERVER URL
========================================= */

const AI_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:5055"
    : "https://study-optimizer-ai.onrender.com";

/* =========================================
   TOKEN
========================================= */

async function getToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not logged in");
  return await user.getIdToken();
}

/* =========================================
   POST HELPER
========================================= */

async function postJSON(path, body) {
  const token = await getToken();

  const res = await fetch(`${AI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || "AI request failed");
  }

  return data;
}

/* =========================================
   AI FUNCTIONS
========================================= */

export function aiGeneratePlan(input) {
  return postJSON("/ai/plan", { input });
}

export function aiGenerateInsights(payload) {
  return postJSON("/ai/insights", payload);
}

export function aiOptimizePlan(payload) {
  return postJSON("/ai/optimize", { payload });
}