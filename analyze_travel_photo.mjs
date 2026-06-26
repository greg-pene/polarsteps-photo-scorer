#!/usr/bin/env node
/**
 * Travel photo scorer using Cloudinary Media Analyze API.
 *
 * Scoring logic:
 *  - Text or signs detected               → skip AI Vision, score < 25
 *  - People (faces) or landscape/adventure → skip AI Vision, score > 75
 *  - Otherwise                             → AI Vision general prompt, score 1–100
 *
 * Usage:
 *   CLOUDINARY_CLOUD_NAME=xxx CLOUDINARY_API_KEY=yyy CLOUDINARY_API_SECRET=zzz \
 *     node analyze_travel_photo.mjs <image_url_or_asset_id> [<image2> ...]
 */

const CLOUD_NAME  = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY     = process.env.CLOUDINARY_API_KEY;
const API_SECRET  = process.env.CLOUDINARY_API_SECRET;

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error("Missing required env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
  process.exit(1);
}

const BASE_URL = `https://api.cloudinary.com/v2/analysis/${CLOUD_NAME}/analyze`;
const AUTH = "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");

// ── Google Tagging labels that indicate a good travel photo ──────────────────
// google_tagging returns label annotations; these map to "travel-worthy" categories
const TRAVEL_IMAGE_TYPES = new Set([
  "adventure", "landscape", "seascape", "travel", "nature", "scenic",
  "mountain", "beach", "ocean", "sea", "forest", "desert", "valley",
  "waterfall", "lake", "river", "sky", "sunset", "sunrise", "wilderness",
  "outdoor", "natural landscape", "highland", "fjord", "canyon",
  "mountainous landforms", "mountain range", "glacial landform",
  "people in nature", "hill", "hill station", "alps", "summit",
  "massif", "fell", "ridge", "vacation",
]);

// ── Sign-like LVIS/COCO tags that indicate a low-quality travel photo ─────────
const SIGN_TAGS = new Set(["street_sign", "stop_sign", "sign", "traffic_sign", "road_sign", "billboard"]);

// ── AI Vision prompt ──────────────────────────────────────────────────────────
const AI_VISION_PROMPT =
  "Give the image a score from 1 to 100 based on how likely it is to be a good travel photo. " +
  "Faces, landscapes, scenic/travel shots should be between 75-100, while screenshots, signs, " +
  "text-heavy or low-context images should score between 0-25. Images that contain both aspects " +
  "should score between 25-75. The value should be higher for more engaging images. " +
  'Respond with ONLY a JSON object in this format: {"score": <number>}';

// ─────────────────────────────────────────────────────────────────────────────

async function analyze(model, source) {
  const body = { source: isAssetId(source) ? { asset_id: source } : { uri: source } };

  if (model === "ai_vision_general") {
    body.prompts = [AI_VISION_PROMPT];
  }

  const res = await fetch(`${BASE_URL}/${model}`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${model} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function isAssetId(s) {
  // Asset IDs are hex strings (32 chars); URLs contain "://"
  return !s.includes("://");
}

// ── Helpers to read analysis results ─────────────────────────────────────────

// Tags are { partName: [ { categories: [...], confidence } ] } (human_anatomy shape)
// or { tagName: { confidence } } for other models. Returns flat { name: confidence }.
function getTags(result) {
  const tags = result?.data?.analysis?.tags;
  if (!tags || typeof tags !== "object") return {};
  const out = {};
  for (const [key, val] of Object.entries(tags)) {
    const arr = Array.isArray(val) ? val : [val];
    const maxConf = Math.max(...arr.map((d) => d?.confidence ?? d?.value ?? 1));
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

function hasAnyTag(tags, tagSet) {
  return Object.keys(tags).some((t) => tagSet.has(t));
}

function hasHeadTag(anatomyResult) {
  const tags = getTags(anatomyResult);
  return "head" in tags || Object.keys(tags).some((k) => k.includes("face"));
}

function hasText(cldTextResult) {
  const analysis = cldTextResult?.data?.analysis;
  // cld_text returns tags with detected text regions; non-empty tags means text found
  if (analysis?.tags && Object.keys(analysis.tags).length > 0) return true;
  // Some versions return a has_text boolean
  if (analysis?.has_text === true) return true;
  return false;
}

// google_tagging shape: data.analysis.label_annotations.labels: [{ label, score }]
function getGoogleLabels(googleTagResult) {
  const labels = googleTagResult?.data?.analysis?.label_annotations?.labels;
  if (Array.isArray(labels)) {
    return labels.map((l) => (l.label ?? "").toLowerCase());
  }
  return [];
}

function isTravelImageType(googleTagResult) {
  return getGoogleLabels(googleTagResult).some((l) => TRAVEL_IMAGE_TYPES.has(l));
}

function hasSign(lvisResult, cocoResult) {
  const lvisTags = getTags(lvisResult);
  const cocoTags = getTags(cocoResult);
  return hasAnyTag(lvisTags, SIGN_TAGS) || hasAnyTag(cocoTags, SIGN_TAGS);
}

function getIQAScore(iqaResult) {
  const analysis = iqaResult?.data?.analysis;
  // score is 0–1; convert to 0–100
  const raw = analysis?.score ?? analysis?.quality_score;
  return raw != null ? Math.round(raw * 100) : null;
}

function parseAIVisionScore(aiVisionResult) {
  const responses = aiVisionResult?.data?.analysis?.responses;
  if (!Array.isArray(responses) || responses.length === 0) return null;
  const text = responses[0]?.value ?? responses[0];
  try {
    const parsed = JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
    return typeof parsed.score === "number" ? Math.round(parsed.score) : null;
  } catch {
    // fallback: extract first number from response
    const match = String(text).match(/\d+/);
    return match ? Math.min(100, Math.max(1, parseInt(match[0], 10))) : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function scoreImage(imageSource) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Image: ${imageSource}`);
  console.log("─".repeat(60));

  // Run all fast analyses in parallel
  const [anatomyRes, googleTagRes, lvisRes, cocoRes, cldTextRes, iqaRes] = await Promise.all([
    analyze("human_anatomy",   imageSource).catch((e) => { console.warn("  [warn] human_anatomy:",   e.message); return null; }),
    analyze("google_tagging",  imageSource).catch((e) => { console.warn("  [warn] google_tagging:",  e.message); return null; }),
    analyze("lvis",            imageSource).catch((e) => { console.warn("  [warn] lvis:",            e.message); return null; }),
    analyze("coco",            imageSource).catch((e) => { console.warn("  [warn] coco:",            e.message); return null; }),
    analyze("cld_text",        imageSource).catch((e) => { console.warn("  [warn] cld_text:",        e.message); return null; }),
    analyze("image_quality",   imageSource).catch((e) => { console.warn("  [warn] image_quality:",   e.message); return null; }),
  ]);

  // ── Interpret results ──────────────────────────────────────────────────────
  const hasFaces      = (anatomyRes ? hasHeadTag(anatomyRes) : false)
                     || "person" in getTags(cocoRes)
                     || "person" in getTags(lvisRes);
  const isTravelType  = googleTagRes ? isTravelImageType(googleTagRes)     : false;
  const hasSignInImg  = (lvisRes || cocoRes) ? hasSign(lvisRes, cocoRes)   : false;
  const textDetected  = cldTextRes  ? hasText(cldTextRes)                  : false;
  const iqaScore      = iqaRes      ? getIQAScore(iqaRes)                  : null;

  const detectedLabels = googleTagRes ? getGoogleLabels(googleTagRes) : [];
  const matchedTravelLabels = detectedLabels.filter((l) => TRAVEL_IMAGE_TYPES.has(l));

  console.log("Analysis summary:");
  console.log(`  Faces/people detected : ${hasFaces}`);
  console.log(`  Google labels (travel): ${matchedTravelLabels.join(", ") || "(none)"}`);
  console.log(`  Is travel type        : ${isTravelType}`);
  console.log(`  Signs detected        : ${hasSignInImg}`);
  console.log(`  Text detected         : ${textDetected}`);
  console.log(`  IQA score (0-100)     : ${iqaScore ?? "(unavailable)"}`);

  // ── Scoring decision ───────────────────────────────────────────────────────
  let score;
  let method;

  if ((textDetected || hasSignInImg) && !hasFaces && !isTravelType) {
    // Low-quality: screenshot, signage, text-heavy
    score  = iqaScore != null ? Math.min(24, Math.round(iqaScore * 0.3)) : Math.floor(Math.random() * 15) + 5;
    method = `rule-based (low) — ${textDetected ? "text" : ""}${textDetected && hasSignInImg ? " + " : ""}${hasSignInImg ? "sign" : ""} detected`;
  } else if (hasFaces || isTravelType) {
    // High-quality: people or scenic travel image
    const base = 75;
    const boost = iqaScore != null ? Math.round((iqaScore - 50) * 0.5) : 0; // IQA nudges ±25
    score  = Math.min(100, Math.max(75, base + boost));
    method = `rule-based (high) — ${hasFaces ? "faces" : ""}${hasFaces && isTravelType ? " + " : ""}${isTravelType ? matchedTravelLabels.join(", ") : ""} detected`;
  } else {
    // Ambiguous — ask AI Vision
    console.log("\n  → Running AI Vision for scoring...");
    const aiRes = await analyze("ai_vision_general", imageSource).catch((e) => {
      console.warn("  [warn] ai_vision_general:", e.message);
      return null;
    });
    const aiScore = aiRes ? parseAIVisionScore(aiRes) : null;
    score  = aiScore ?? 50; // fallback to neutral
    method = aiScore != null ? "AI Vision general" : "AI Vision (fallback=50)";
  }

  console.log(`\n  ✦ Final score : ${score} / 100`);
  console.log(`  Method        : ${method}`);

  return { image: imageSource, score, method, details: { hasFaces, isTravelType, matchedTravelLabels, hasSignInImg, textDetected, iqaScore } };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const images = process.argv.slice(2);
  if (images.length === 0) {
    console.error("Usage: node analyze_travel_photo.mjs <image_url_or_asset_id> [<image2> ...]");
    process.exit(1);
  }

  const results = [];
  for (const img of images) {
    try {
      results.push(await scoreImage(img));
    } catch (err) {
      console.error(`Error processing ${img}:`, err.message);
      results.push({ image: img, score: null, error: err.message });
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(60));
  for (const r of results) {
    const score = r.score != null ? `${r.score}/100` : "ERROR";
    console.log(`  ${score.padStart(7)}  ${r.image}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
