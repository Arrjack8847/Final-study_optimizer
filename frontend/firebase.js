// frontend/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// ✅ your config
const firebaseConfig = {
  apiKey: "AIzaSyCoGrJn27Qj-Ckm0Uh9dBcTlp9iSh5n0qQ",
  authDomain: "study-burn-out.firebaseapp.com",
  projectId: "study-burn-out",
  storageBucket: "study-burn-out.firebasestorage.app",
  messagingSenderId: "561193902272",
  appId: "1:561193902272:web:9f5c22033e58da73dbcd25",
  measurementId: "G-5TH9VZ28J6",
};

export const app = initializeApp(firebaseConfig);

// ✅ SINGLETONS
export const auth = getAuth(app);
export const db = getFirestore(app);

// ✅ AUTH HELPERS
export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function logout() {
  await signOut(auth);
}

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/**
 * ✅ Register user (email/password)
 * Optional: pass { displayName } to set profile name.
 */
export async function register(email, password, opts = {}) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);

  if (opts?.displayName) {
    try {
      await updateProfile(cred.user, { displayName: String(opts.displayName) });
    } catch (e) {
      console.warn("updateProfile failed:", e?.message || e);
    }
  }

  return cred.user;
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);

  // optional: make sure user doc exists for google users too
  await ensureUserDoc(cred.user);

  return cred.user;
}

/* =========================================
   ✅ USER PROFILE (Firestore users/{uid})
   ========================================= */

/**
 * Create users/{uid} if missing (safe for Google login).
 */
export async function ensureUserDoc(user) {
  if (!user?.uid) return;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        uid: user.uid,
        email: user.email || null,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        provider: user.providerData?.[0]?.providerId || "unknown",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}

/**
 * Save/merge profile fields into users/{uid}
 * This will NOT overwrite createdAt if it already exists.
 */
export async function saveUserProfile(uid, data = {}) {
  if (!uid) throw new Error("saveUserProfile: uid is required");

  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);

  const base = {
    updatedAt: serverTimestamp(),
  };

  // only set createdAt once
  if (!snap.exists()) {
    base.createdAt = serverTimestamp();
  }

  await setDoc(
    ref,
    {
      ...base,
      ...data,
      uid,
    },
    { merge: true }
  );
}