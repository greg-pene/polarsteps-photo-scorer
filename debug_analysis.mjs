#!/usr/bin/env node
/**
 * Debug all analysis models for a given image URL.
 * Prints the raw JSON response for each model.
 *
 * Usage:
 *   CLOUDINARY_CLOUD_NAME=x CLOUDINARY_API_KEY=y CLOUDINARY_API_SECRET=z \
 *     node debug_analysis.mjs <image_url> [model1,model2,...]
 *
 * Models: human_anatomy, lvis, coco, cld_text, image_quality, google_tagging
 * Default: all models
 */

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const url        = process.argv[2];
const selected   = process.argv[3]?.split(",");

if (!CLOUD_NAME || !API_KEY || !API_SECRET || !url) {
  console.error("Usage: CLOUDINARY_CLOUD_NAME=x CLOUDINARY_API_KEY=y CLOUDINARY_API_SECRET=z node debug_analysis.mjs <url> [model1,model2,...]");
  process.exit(1);
}

const ALL_MODELS = ["human_anatomy", "lvis", "coco", "cld_text", "image_quality", "google_tagging"];
const models = selected ?? ALL_MODELS;

const AUTH = "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
const BASE  = `https://api.cloudinary.com/v2/analysis/${CLOUD_NAME}/analyze`;

async function run(model) {
  const res = await fetch(`${BASE}/${model}`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ source: { uri: url } }),
  });
  return res.json();
}

const results = await Promise.all(models.map(async (m) => {
  try   { return { model: m, ok: true,  data: await run(m) }; }
  catch (e) { return { model: m, ok: false, error: e.message }; }
}));

for (const { model, ok, data, error } of results) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`MODEL: ${model}`);
  console.log("═".repeat(60));
  if (ok) console.log(JSON.stringify(data, null, 2));
  else    console.log(`ERROR: ${error}`);
}
