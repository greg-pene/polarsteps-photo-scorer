# Travel Photo Scorer

Scores travel photos using the [Cloudinary Media Analyze API](https://cloudinary.com/documentation/analyze_api_guide), then visualises results in an interactive dashboard.

**[Open the results viewer →](https://greg-pene.github.io/polarsteps-photo-scorer/)**

---

## How it works

Each image is analysed in parallel by 5 models:

| Model | Purpose |
|---|---|
| `coco` | People / faces detection |
| `lvis` | Travel scene tags + sign detection |
| `cld_text` | Text presence |
| `image_quality` | IQA score (0–100) |
| `google_tagging` | Scene labels (landscape, adventure, mountain…) |

Scoring rules (in priority order):

1. **Text or signs detected** → score < 25 (low)
2. **Faces or travel labels detected** → score > 75 (high), nudged by IQA
3. **Ambiguous** → `ai_vision_general` is called with a travel scoring prompt → score 1–100

---

## Setup

**Requirements:** Node.js 18+

```bash
git clone https://github.com/greg-pene/polarsteps-photo-scorer.git
cd polarsteps-photo-scorer
cp .env.example .env
```

Edit `.env` with your Cloudinary credentials:

```
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

---

## Usage

### Score a batch of images

Prepare a CSV with image URLs in the first column (header row optional):

```
url
https://res.cloudinary.com/your-cloud/image/upload/photo1.jpg
https://res.cloudinary.com/your-cloud/image/upload/photo2.jpg
```

Run the scorer:

```bash
./analyze_photos.sh input.csv
# → writes input_scored.csv
```

Or with an explicit output path:

```bash
./analyze_photos.sh input.csv results.csv
```

### Score a single image

```bash
node analyze_travel_photo.mjs https://res.cloudinary.com/your-cloud/image/upload/photo.jpg
```

### Debug raw API responses

```bash
# All models
node debug_analysis.mjs https://res.cloudinary.com/your-cloud/image/upload/photo.jpg

# Specific models only
node debug_analysis.mjs <url> coco,lvis,cld_text
```

---

## Output CSV columns

| Column | Description |
|---|---|
| `url` | Original image URL |
| `faces_detected` | `true` if people detected (COCO) |
| `travel_labels` | Matched travel labels from Google Tagging, pipe-separated |
| `signs_detected` | `true` if signs detected (LVIS) |
| `text_detected` | `true` if text detected (cld_text) |
| `iqa_score` | Image quality score 0–100 |
| `final_score` | Travel score 0–100 |
| `method` | How the score was determined (`rule:high`, `rule:low`, `ai_vision_general`) |
| `ai_vision_called` | `true` if AI Vision was used |
| `ai_vision_tokens` | AI Vision quota consumed |
| `addon_units` | Object detection quota consumed (4 per image) |
| `google_units` | Google Tagging quota consumed (1 per image) |

---

## Results viewer

Drop your scored CSV onto the [hosted viewer](https://greg-pene.github.io/polarsteps-photo-scorer/) to explore results:

- Score distribution histogram and method breakdown chart
- **Table view** — sortable columns, thumbnails with score overlay
- **Grid view** — asset cards with large thumbnails and per-image details
- **Compound score** — adjust weights for each signal (faces, travel labels, IQA, text penalty, sign penalty, AI Vision) to re-rank images interactively

The viewer is client-side only — your CSV never leaves the browser.
