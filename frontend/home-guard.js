// home-guard.js
import { watchAuth } from "./firebase.js";

const LOGIN_PAGE = "first.html";

const unsubscribe = watchAuth((user) => {
  // Wait until Firebase finishes restoring session
  // If user === null AFTER init → redirect
  if (!user) {
    // avoid redirect loop if already on login page
    if (!window.location.pathname.endsWith(LOGIN_PAGE)) {
      window.location.replace(LOGIN_PAGE);
    }
  }

  // Stop listening once auth resolved
  unsubscribe();
});
