import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

/* =========================================================
   BASIC MIDDLEWARE
========================================================= */

app.use(express.json({ limit: "1mb" }));

// ✅ SAFE CORS (NO MORE 500)
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      // Allow localhost
      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1")
      ) {
        return callback(null, true);
      }

      // Allow Vercel deployments
      if (origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }

      // Allow everything else (safe for now)
      return callback(null, true);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* =========================================================
   ENV CHECK
========================================================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY");
}

if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
}

/* =========================================================
   FIREBASE ADMIN INIT
========================================================= */

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)
  ),
});

/* =========================================================
   GEMINI INIT
========================================================= */

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };

    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* =========================================================
   SAFE JSON PARSER
========================================================= */

function parseJSON(text) {
  let s = String(text || "").trim();

  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").trim();
    s = s.replace(/```$/i, "").trim();
  }

  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(s);
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (_, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.get("/version", (_, res) => {
  res.json({ ok: true, version: "chat-route-fixed" });
});

/* =========================================================
   AI CHAT
========================================================= */

app.post("/ai/chat", requireUser, async (req, res) => {
  try {
    const messages = req.body?.messages || [];

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages[]" });
    }

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    }));

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You are a helpful study assistant. Give short, practical advice. Avoid long essays. If user is stressed, give calm actionable steps.",
    });

    const result = await model.generateContent({ contents });

    const reply =
      result?.response?.text?.()?.trim() ||
      "Sorry, I couldn't generate a response.";

    res.json({ reply });
  } catch (e) {
    console.error("Chat error:", e);
    res.status(500).json({
      error: "Chat failed",
      details: String(e.message || e),
    });
  }
});

/* =========================================================
   GLOBAL ERROR HANDLER (Prevents silent 500)
========================================================= */

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    error: "Server error",
    details: err?.message || String(err),
  });
});

/* =========================================================
   SERVER START (RENDER SAFE)
========================================================= */

const port = process.env.PORT || 5055;

app.listen(port, () => {
  console.log(`AI server running on port ${port}`);
  console.log(
    "Gemini key length:",
    (process.env.GEMINI_API_KEY || "").length
  );
});
