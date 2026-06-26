#!/usr/bin/env node
/**
 * Batch travel-photo scorer — reads a CSV of image URLs, writes results CSV.
 *
 * Input CSV:  one URL per row (first column used; extra columns preserved as-is)
 * Output CSV: url, faces_detected, travel_labels, signs_detected, text_detected,
 *             iqa_score, final_score, method, ai_vision_called, total_quota_used,
 *             [original extra cols...]
 *
 * Models used per image (parallel):
 *   human_anatomy — face/people detection (face tags + categories)
 *   coco          — people detection (reliable "person" tag, 80 categories)
 *   lvis          — travel scene + sign detection (1200+ category vocabulary)
 *   cld_text      — text presence
 *   image_quality — IQA score
 *
 * Usage:
 *   CLOUDINARY_CLOUD_NAME=xxx CLOUDINARY_API_KEY=yyy CLOUDINARY_API_SECRET=zzz \
 *     node analyze_csv.mjs input.csv output.csv
 */

import { createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error("Missing env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
  process.exit(1);
}

const [,, inputFile, outputFile] = process.argv;
if (!inputFile || !outputFile) {
  console.error("Usage: node analyze_csv.mjs <input.csv> <output.csv>");
  process.exit(1);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = `https://api.cloudinary.com/v2/analysis/${CLOUD_NAME}/analyze`;
const AUTH     = "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");

// Google Tagging labels that indicate a travel-worthy scene
const TRAVEL_LABELS = new Set([
  "adventure", "landscape", "seascape", "travel", "nature", "scenic",
  "mountain", "beach", "ocean", "sea", "forest", "desert", "valley",
  "waterfall", "lake", "river", "sky", "sunset", "sunrise", "wilderness",
  "outdoor", "natural landscape", "highland", "fjord", "canyon",
  "mountainous landforms", "mountain range", "glacial landform",
  "people in nature", "hill", "hill station", "alps", "summit",
  "massif", "fell", "ridge", "vacation",
]);

// LVIS categories that suggest a travel-worthy scene (kept for sign detection context)
const TRAVEL_TAGS = new Set([
  "mountain", "beach", "ocean", "sea", "lake", "river", "waterfall",
  "forest", "desert", "valley", "canyon", "fjord", "glacier",
  "sky", "sunset", "sunrise", "hill", "cliff", "island",
  "sand", "wave", "reef", "cave", "volcano",
  "tent", "campfire", "kayak", "canoe", "sailboat",
  "ski", "snowboard", "surfboard", "hiking",
]);

// LVIS/COCO categories that indicate signs/text-heavy content
const SIGN_TAGS = new Set([
  "street_sign", "stop_sign", "sign", "traffic_sign", "road_sign", "billboard",
  "banner", "poster", "menu",
]);

const AI_VISION_PROMPT =
  "Give the image a score from 1 to 100 based on how likely it is to be a good travel photo. " +
  "Faces, landscapes, scenic/travel shots should be between 75-100, while screenshots, signs, " +
  "text-heavy or low-context images should score between 0-25. Images that contain both aspects " +
  "should score between 25-75. The value should be higher for more engaging images. " +
  'Respond with ONLY a JSON object in this format: {"score": <number>}';

// ─── API helpers ─────────────────────────────────────────────────────────────

async function analyze(model, source, extra = {}) {
  const body = {
    source: source.includes("://") ? { uri: source } : { asset_id: source },
    ...extra,
  };
  const res = await fetch(`${BASE_URL}/${model}`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${model} (${res.status}): ${text}`);
  }
  return res.json();
}

function quotaUsed(result) {
  const limits = result?.limits;
  if (!limits) return 0;
  const arr = Array.isArray(limits) ? limits : (Array.isArray(limits.addons_quota) ? limits.addons_quota : []);
  return arr.reduce((sum, l) => sum + (l.used_by_request ?? 0), 0);
}

// ─── Result parsers ──────────────────────────────────────────────────────────

// Tags shape: { tagName: [{ categories: [...], confidence }] }
// Returns flat map { name: maxConfidence } including tag keys and their categories
function getTags(result) {
  const tags = result?.data?.analysis?.tags;
  if (!tags || typeof tags !== "object") return {};
  const out = {};
  for (const [key, detections] of Object.entries(tags)) {
    const arr = Array.isArray(detections) ? detections : [detections];
    const maxConf = Math.max(...arr.map((d) => d?.confidence ?? 1));
    out[key.toLowerCase()] = maxConf;
    for (const d of arr) {
      for (const cat of (d?.categories ?? [])) {
        const c = cat.toLowerCase();
        out[c] = Math.max(out[c] ?? 0, maxConf);
      }
    }
  }
  return out;
}

// human_anatomy: face parts have keys like "left-face", "right-face" or category "head"
function hasFaceTag(r) {
  const t = getTags(r);
  return "head" in t || Object.keys(t).some((k) => k.includes("face"));
}

// coco: reliable "person" detection (80-category model)
function hasPersonCoco(r) {
  return "person" in getTags(r);
}

// lvis: large-vocabulary model — check travel scenes and signs
function getLvisTravelTags(r) {
  const tags = getTags(r);
  return Object.keys(tags).filter((t) => TRAVEL_TAGS.has(t));
}

// google_tagging shape: data.analysis.label_annotations.labels: [{ label, score }]
function getGoogleLabels(r) {
  const labels = r?.data?.analysis?.label_annotations?.labels;
  if (Array.isArray(labels)) return labels.map((l) => (l.label ?? "").toLowerCase());
  return [];
}

function hasSignLvis(r) {
  const tags = getTags(r);
  return Object.keys(tags).some((t) => SIGN_TAGS.has(t));
}

function hasText(r) {
  const a = r?.data?.analysis;
  if (!a) return false;
  if (a.has_text === true) return true;
  return a.tags && Object.keys(a.tags).length > 0;
}

function getIQAScore(r) {
  const a = r?.data?.analysis;
  if (!a) return null;
  const raw = a.score ?? a.quality_score;
  return raw != null ? Math.round(raw * 100) : null;
}

function parseAIVisionScore(r) {
  const responses = r?.data?.analysis?.responses;
  if (!Array.isArray(responses) || !responses.length) return null;
  const text = responses[0]?.value ?? responses[0];
  try {
    const parsed = JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
    return typeof parsed.score === "number" ? Math.round(parsed.score) : null;
  } catch {
    const m = String(text).match(/\d+/);
    return m ? Math.min(100, Math.max(1, parseInt(m[0], 10))) : null;
  }
}

// ─── Core scoring ─────────────────────────────────────────────────────────────

async function scoreImage(url) {
  const safe = (promise, name) =>
    promise.catch((e) => { process.stderr.write(`  [warn] ${name}: ${e.message}\n`); return null; });

  const [cocoR, lvisR, textR, iqaR, googleR] = await Promise.all([
    safe(analyze("coco",           url), "coco"),
    safe(analyze("lvis",           url), "lvis"),
    safe(analyze("cld_text",       url), "cld_text"),
    safe(analyze("image_quality",  url), "image_quality"),
    safe(analyze("google_tagging", url), "google_tagging"),
  ]);

  const hasFaces     = hasPersonCoco(cocoR);
  const allGoogleLabels = getGoogleLabels(googleR);
  const travelLabels = allGoogleLabels.filter((l) => TRAVEL_LABELS.has(l));
  const isTravelType = travelLabels.length > 0;
  process.stderr.write(`  google labels: ${allGoogleLabels.slice(0, 8).join(", ") || "(none)"}\n`);
  process.stderr.write(`  travel match : ${travelLabels.join(", ") || "(none)"}\n`);
  const signDetected = hasSignLvis(lvisR);
  const textDetected = textR ? hasText(textR) : false;
  const iqaScore     = iqaR  ? getIQAScore(iqaR) : null;

  const addonUnits  = [cocoR, lvisR, textR, iqaR].reduce((sum, r) => sum + quotaUsed(r), 0);
  const googleUnits = quotaUsed(googleR);
  let aiVisionTokens = 0;
  let aiVisionCalled = false;
  let score, method;

  if ((textDetected || signDetected) && !hasFaces && !isTravelType) {
    score  = iqaScore != null ? Math.min(24, Math.round(iqaScore * 0.3)) : 10;
    method = `rule:low(${textDetected ? "text" : ""}${textDetected && signDetected ? "+" : ""}${signDetected ? "sign" : ""})`;
  } else if (hasFaces || isTravelType) {
    const boost = iqaScore != null ? Math.round((iqaScore - 50) * 0.5) : 0;
    score  = Math.min(100, Math.max(75, 75 + boost));
    method = `rule:high(${hasFaces ? "faces" : ""}${hasFaces && isTravelType ? "+" : ""}${isTravelType ? travelLabels.join("|") : ""})`;
  } else {
    aiVisionCalled = true;
    const aiR = await safe(analyze("ai_vision_general", url, { prompts: [AI_VISION_PROMPT] }), "ai_vision_general");
    const aiScore = aiR ? parseAIVisionScore(aiR) : null;
    aiVisionTokens = quotaUsed(aiR);
    score  = aiScore ?? 50;
    method = aiScore != null ? "ai_vision_general" : "ai_vision_general(fallback=50)";
  }

  return {
    url,
    faces_detected:    hasFaces,
    travel_labels:     travelLabels.join("|"),
    signs_detected:    signDetected,
    text_detected:     textDetected,
    iqa_score:         iqaScore ?? "",
    final_score:       score,
    method,
    ai_vision_called:  aiVisionCalled,
    ai_vision_tokens:  aiVisionTokens,
    addon_units:       addonUnits,
    google_units:      googleUnits,
  };
}

// ─── CSV I/O ──────────────────────────────────────────────────────────────────

function csvEscape(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function parseCsvRow(line) {
  const fields = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const OUTPUT_COLS = [
    "url", "faces_detected", "travel_labels", "signs_detected",
    "text_detected", "iqa_score", "final_score", "method",
    "ai_vision_called", "ai_vision_tokens", "addon_units", "google_units",
  ];

  const rl  = createInterface({ input: createReadStream(inputFile), crlfDelay: Infinity });
  const out = createWriteStream(outputFile);

  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(parseCsvRow(line));
  }

  let extraHeaders = [];
  let dataRows = rows;
  if (rows.length && !/^https?:\/\//i.test(rows[0][0])) {
    extraHeaders = rows[0].slice(1);
    dataRows = rows.slice(1);
  }

  const total = dataRows.length;
  out.write([...OUTPUT_COLS, ...extraHeaders].map(csvEscape).join(",") + "\n");

  let done = 0;
  for (const fields of dataRows) {
    const url = fields[0]?.trim();
    const extra = fields.slice(1);
    if (!url) continue;

    done++;
    process.stderr.write(`[${done}/${total}] ${url}\n`);

    let result;
    try {
      result = await scoreImage(url);
    } catch (err) {
      process.stderr.write(`  ERROR: ${err.message}\n`);
      result = {
        url, faces_detected: "", travel_labels: "", signs_detected: "",
        text_detected: "", iqa_score: "", final_score: "ERROR",
        method: err.message.slice(0, 80), ai_vision_called: "", ai_vision_tokens: "", addon_units: "", google_units: "",
      };
    }

    out.write([...OUTPUT_COLS.map((c) => result[c]), ...extra].map(csvEscape).join(",") + "\n");
  }

  out.end();
  process.stderr.write(`\nDone. ${done} images → ${outputFile}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
