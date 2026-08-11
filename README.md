# Case Register — Document Extractor

A single-page tool: upload supporting documents for a case (passport page, employer
letter, appointment/flight confirmation, insurance certificate), and it drafts a
case record matching the fields below for you to review, edit, and log.

Fields extracted: Name, Surname, Gender, Passport number, Date appointment, AIP Date,
Flight Date, Accommodation, Insurance, Insurance Expiry, Skills pass, Job title,
Employer, result, Comments.

No backend. It's a static page (`index.html` + `app.js`) that:
- reads text directly out of text-based PDFs (`pdf.js`, loaded from a CDN),
- sends images, and scanned PDFs with no text layer, straight to the
  **Gemini API** for extraction (Gemini reads PDFs and images natively),
- shows you the draft so you can correct anything before it's saved,
- keeps a running case log in the browser (`localStorage`) with CSV export.

## Before you use it

You need a Gemini API key — free, no credit card required:

1. Go to **aistudio.google.com** and sign in.
2. Click **Get API key → Create API key**.
3. Copy the key (starts with `AIza...`) and paste it into the page.

The page keeps it in your browser's `localStorage` — it is **never** written
to this repo or sent anywhere except `generativelanguage.googleapis.com`.

**Two caveats to know about the free tier:**
- Google's free tier terms allow prompts/documents sent through it to be used
  to improve their products. That's a real consideration here since you're
  sending passport numbers and personal case data — if that's a concern,
  switch to a paid Gemini key (same account, just enable billing) or a
  different provider; the extraction logic is isolated in `runExtraction()`
  in `app.js` so swapping providers later is a contained change.
- Because this is a static page with no server, the key lives in your browser
  and every request is made directly from it — fine for personal/local use,
  but don't host this on a shared machine without clearing the key, and never
  commit a key into the repo.

Passport numbers and personal case data are sensitive — treat the case log
(and any exported CSV) the same way you'd treat a paper case file.

## Running it locally

Just open `index.html` in a browser. No build step, no install.

## Hosting it on GitHub Pages

1. Create a **new** GitHub repository (don't reuse an existing one) —
   e.g. `case-register`.
2. Push this folder to it (see commands below).
3. In the repo: **Settings → Pages → Source → Deploy from branch → main → / (root)**.
4. GitHub gives you a URL like `https://<your-username>.github.io/case-register/`.

## Pushing this to your GitHub

This folder is already a local git repo with one commit. To push it to a new
repo of your own **without touching any existing repo or data**:

```bash
# 1. Create a new, empty repository on github.com first (no README/license),
#    then copy its URL, e.g.:
#    https://github.com/samkiller222/case-register.git

# 2. From inside this folder:
git remote add origin https://github.com/samkiller222/case-register.git
git branch -M main
git push -u origin main
```

That's it — this only touches the new repo you just created; it never reads
from or writes to any other repository.

## Known limitations (v1)

- Extraction quality depends on document clarity — always check the draft
  before saving to the log, especially the passport number and dates.
- Free-tier Gemini has daily/per-minute request caps (generous for individual
  use, but if you hit a 429 error, wait a minute and retry).
- The case log lives in one browser's `localStorage` — it won't sync across
  devices. Export to CSV regularly if you want a durable copy.
