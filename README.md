# Case Register — Document Extractor

A single-page tool: upload supporting documents for a case (passport page, employer
letter, appointment/flight confirmation, insurance certificate), and it drafts a
case record matching the fields below for you to review, edit, and log.

Fields extracted: Name, Surname, Gender, Passport number, Date appointment, AIP Date,
Flight Date, Accommodation, Insurance, Insurance Expiry, Skills pass, Job title,
Employer, result, Comments.

No backend required. It's a static page (`index.html` + `app.js`) that:
- reads text directly out of text-based PDFs (`pdf.js`, loaded from a CDN),
- sends images, and scanned PDFs with no text layer, to whichever
  **extraction engine** you pick — your own **home server**, or the
  **Gemini API** as a cloud fallback (Gemini reads PDFs and images
  natively),
- checks the uploaded documents against Malta's Central Visa Unit
  "Documentation Required for Employment Visa" checklist (10 items: visa
  form, passport validity, photo, AIP timing, VFS appointment, flight
  itinerary, insurance thresholds, accommodation proof, Skills Pass,
  fees) and shows each item as Compliant / Non-compliant / Missing / Not
  applicable, with a one-line reason,
- shows you the draft so you can correct anything before it's saved,
- keeps a running case log in the browser (`localStorage`) with CSV export
  (including a `checklist_issues` column summarizing any flagged items),
- supports a **dark mode** toggle (top-right of the header) that remembers
  your choice.

## Apps menu

The hamburger icon (top-left) switches between the tools this page holds —
right now:

- **Case intake** — the document upload / extraction / checklist / case log
  flow described above.
- **Email writer** — drafts a document-revision request email. Hitting
  "Load from current case" (or opening the tab for the first time after an
  extraction) pulls the applicant's name, passport number, and a salutation
  guessed from gender straight from the current draft, and turns every
  Non-compliant/Missing checklist item into a findings bullet automatically.
  Findings are editable free text either way, and the tool works standalone
  (no case loaded, no AI call) if you just want to type an email from
  scratch. Application type (Sport / Student / Employment) picks which
  Central Visa Unit checklist link goes in the email body.

## Extraction engine: home server vs. Gemini

The "Extraction engine" dropdown on the page switches between two ways of
processing documents — nothing else about the page changes:

- **Home server (local model)** — your own server, reachable at a URL you
  provide. The page `POST`s the files as `multipart/form-data` to
  `<your-url>/extract` with `Authorization: Bearer <your-token>`, and
  expects back a JSON body shaped like the extracted record (the same keys
  as the Gemini path, plus an optional `checklist` array — see
  `app.js`/`normalizeChecklist` for the exact shape). Nothing reaches a
  third-party AI provider; documents go straight from your browser to your
  server over HTTPS. This mode is selected by default.
- **Gemini (cloud fallback)** — sends documents directly to Google's
  `generativelanguage.googleapis.com` using a Gemini API key you supply
  (free, no credit card — go to **aistudio.google.com**, **Get API key →
  Create API key**, and paste the key, which starts with `AIza...`, into
  the page).

Both the URL/token and the API key are kept only in your browser's
`localStorage` — **never** written to this repo or sent anywhere except
the destination you chose.

**Two caveats to know about the Gemini fallback's free tier:**
- Google's free tier terms allow prompts/documents sent through it to be used
  to improve their products. That's a real consideration here since you're
  sending passport numbers and personal case data — if that's a concern,
  switch to a paid Gemini key (same account, just enable billing), or use
  the home server engine instead.
- Because this is a static page with no server of its own, the Gemini key
  lives in your browser and every request is made directly from it — fine
  for personal/local use, but don't host this on a shared machine without
  clearing the key, and never commit a key into the repo.

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
