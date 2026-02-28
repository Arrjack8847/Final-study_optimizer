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
   POST HELPER (WITH REAL ERROR DETAILS)
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

  // Read text first so we can debug even if server didn't return JSON
  const text = await res.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  // ✅ Debug logs (remove later if you want)
  console.log(`✅ ${path} status:`, res.status);
  console.log(`✅ ${path} response text:`, text);

  if (!res.ok) {
    const msg =
      (data && (data.details || data.error)) ||
      text ||
      "AI request failed";
    throw new Error(msg);
  }

  return data ?? { raw: text };
}

/* =========================================
   AI FUNCTIONS
========================================= */

export function aiGeneratePlan(input) {
  return postJSON("/ai/plan", { input });
}

export function aiGenerateInsights(payload) {
  // ✅ backend expects payload or body; this matches your server code
  return postJSON("/ai/insights", { payload });
}

export function aiOptimizePlan(payload) {
  return postJSON("/ai/optimize", { payload });
}
