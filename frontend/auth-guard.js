import { listenAuth } from "./firebase.js";

const currentPage = (location.pathname.split("/").pop() || "").toLowerCase();

// allow landing/login page without auth
const PUBLIC = new Set(["first.html", ""]);

listenAuth((user) => {
  if (!user && !PUBLIC.has(currentPage)) {
    window.location.href = "first.html";
  }
});
