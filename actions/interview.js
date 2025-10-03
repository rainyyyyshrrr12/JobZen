"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";

/** ---------------- Gemini (REST, v1) with dynamic model discovery ----------------
 * Avoids hard-coded models causing 404. Lists available models for your key,
 * picks the best one that supports generateContent, then calls it.
 * Vercel → Settings → Environment Variables → GEMINI_API_KEY
 */

const GEN_PREF = [
  // preferred order (newer → older)
  "gemini-1.5-flash-002",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-002",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  // legacy fallbacks (some projects only have these)
  "gemini-pro",
  "gemini-1.0-pro",
];

async function listModelsV1(key) {
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${key}`;
  const resp = await fetch(url, { method: "GET", cache: "no-store" });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ListModels failed: ${resp.status} ${resp.statusText} – ${body}`);
  }
  const data = await resp.json();
  return data.models || [];
}

/** Returns a model ID that exists + supports generateContent (e.g., "models/gemini-1.5-flash") */
function pickBestModel(available) {
  const supports = new Set(
    available
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => m.name) // API returns "models/<name>"
  );

  for (const pref of GEN_PREF) {
    if (supports.has(`models/${pref}`)) return `models/${pref}`;
  }

  // fallback: first generateContent-capable model
  const first = [...supports][0];
  return first || null;
}

async function geminiGenerate(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Server misconfiguration: GEMINI_API_KEY is missing");

  // 1) Discover models enabled for THIS key/project
  const models = await listModelsV1(key);
  console.log("Gemini models available:", models.map((m) => m.name).join(", "));

  // 2) Pick the best available model that supports generateContent
  const chosen = pickBestModel(models);
  if (!chosen) throw new Error("No Gemini model with generateContent available for this API key");

  // chosen like "models/gemini-1.5-flash"
  const url = `https://generativelanguage.googleapis.com/v1/${chosen}:generateContent?key=${key}`;

  // 3) Call generateContent
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GenerateContent failed: ${resp.status} ${resp.statusText} – ${body}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) throw new Error("Empty model response");
  return text;
}

/** --------- Helpers: prompt + safe JSON extraction --------- */

function buildQuizPrompt(industry, skills) {
  return `
You are an interview question generator.

Generate exactly 10 technical multiple-choice questions for a ${industry} professional${
    skills?.length ? ` with expertise in ${skills.join(", ")}` : ""
  }.

Each item must include:
- "question": string
- "options": array of 4 strings
- "correctAnswer": one of the options
- "explanation": short string

Return ONLY this JSON (no extra text):

{
  "questions": [
    {
      "question": "string",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "A",
      "explanation": "why A is correct"
    }
  ]
}
`.trim();
}

function extractJson(text) {
  // Remove fenced code blocks if present
  let t = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();

  // Try direct parse
  try {
    return JSON.parse(t);
  } catch (_) {
    // Try biggest {} slice
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = t.slice(first, last + 1);
      try {
        return JSON.parse(candidate);
      } catch (e2) {
        console.error("JSON parse failed (candidate):", e2, "\nCandidate:", candidate);
      }
    }
    console.error("JSON parse failed (raw):", t);
    throw new Error("Model returned invalid JSON");
  }
}

/** ---------------------- Actions ---------------------- */

export async function generateQuiz() {
  // Requires Clerk middleware to be active on this route
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: { industry: true, skills: true },
  });
  if (!user) throw new Error("User not found");

  const prompt = buildQuizPrompt(user.industry, user.skills || []);

  try {
    const text = await geminiGenerate(prompt);
    const data = extractJson(text);

    if (!data?.questions || !Array.isArray(data.questions) || data.questions.length !== 10) {
      throw new Error("Model returned unexpected structure");
    }

    return data.questions;
  } catch (error) {
    console.error("Error generating quiz:", error);
    throw new Error("Failed to generate quiz questions");
  }
}

export async function saveQuizResult(questions, answers, score) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, industry: true },
  });
  if (!user) throw new Error("User not found");

  const results = questions.map((q, i) => ({
    question: q.question,
    answer: q.correctAnswer,
    userAnswer: answers[i],
    isCorrect: q.correctAnswer === answers[i],
    explanation: q.explanation,
  }));

  const wrong = results.filter((r) => !r.isCorrect);

  // Generate improvement tip only when needed
  let improvementTip = null;
  if (wrong.length > 0) {
    const wrongText = wrong
      .map(
        (q) =>
          `Question: "${q.question}"\nCorrect Answer: "${q.answer}"\nUser Answer: "${q.userAnswer}"`
      )
      .join("\n\n");

    const tipPrompt = `
User took a ${user.industry} technical quiz and missed several questions.

${wrongText}

Give a concise (<= 2 sentences), encouraging improvement tip that focuses on what to learn next.
Do not mention specific mistakes.
`.trim();

    try {
      const tipText = await geminiGenerate(tipPrompt);
      // Strip any code fences and trim
      improvementTip = tipText.replace(/```[\s\S]*?```/g, "").trim();
      if (improvementTip.length > 300) improvementTip = improvementTip.slice(0, 300);
    } catch (e) {
      console.error("Error generating improvement tip:", e);
      improvementTip = null;
    }
  }

  try {
    const assessment = await db.assessment.create({
      data: {
        userId: user.id,
        quizScore: score,
        questions: results, // Prisma field should be Json
        category: "Technical",
        improvementTip,
      },
    });

    return assessment;
  } catch (error) {
    console.error("Error saving quiz result:", error);
    throw new Error("Failed to save quiz result");
  }
}

export async function getAssessments() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: { id: true },
  });
  if (!user) throw new Error("User not found");

  try {
    const assessments = await db.assessment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    return assessments;
  } catch (error) {
    console.error("Error fetching assessments:", error);
    throw new Error("Failed to fetch assessments");
  }
}
