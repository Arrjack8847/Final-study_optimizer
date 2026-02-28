// frontend/first-auth.js
import { watchAuth, register, login, loginWithGoogle } from "./firebase.js";
import { hasActivePlan } from "./api.js";

function showError(err) {
  console.error("AUTH ERROR:", err);
  alert(err?.code ? `${err.code}\n${err.message}` : (err?.message || String(err)));
}

/**
 * ✅ Decide where to send user after login
 * - If they have an active plan -> go focus.html (or dashboard)
 * - If no plan -> go home.html (create plan)
 *
 * Change these routes to match your project pages.
 */
async function routeAfterLogin() {
  const ok = await hasActivePlan();

  // ✅ Recommended flow:
  // - no plan => home.html (create plan)
  // - has plan => focus.html (start studying)
  const next = ok ? "focus.html" : "home.html";

  // prevent redirect loop
  const current = (location.pathname.split("/").pop() || "").toLowerCase();
  if (current === next.toLowerCase()) return;

  window.location.replace(next);
}

// ✅ Route after login
watchAuth(async (user) => {
  if (!user) return;

  try {
    await routeAfterLogin();
  } catch (err) {
    showError(err);
  }
});

// ✅ Expose signup/login functions for UI scripts
window.__auth = {
  register,
  login,
  loginWithGoogle,
};