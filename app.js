/* Case Register — document extraction
 * Client-side only. Calls generativelanguage.googleapis.com (Gemini) directly
 * from the browser using a key the user supplies (kept in localStorage, never
 * in this repo).
 */

// pdf.js is loaded from a CDN and configured lazily (see extractPdfText) so
// that a blocked/failed CDN load (ad-blockers, corporate proxies, a
// throttled background tab) only breaks PDF text extraction — not the
// whole page. Referencing the global directly at parse time would throw
// and halt this entire script, taking the menu/theme toggle/everything
// else down with it.

// Makes the page installable and caches pdf.js for offline use. Registration
// silently fails on http/file:// or unsupported browsers — extraction still
// works normally either way, this is a pure enhancement.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

const FIELDS = [
  { key: "name", label: "Name", type: "text" },
  { key: "surname", label: "Surname", type: "text" },
  { key: "gender", label: "Gender", type: "select", options: ["", "Male", "Female"] },
  { key: "passport_number", label: "Passport number", type: "text" },
  { key: "date_appointment", label: "Date appointment", type: "text" },
  { key: "aip_date", label: "AIP Date", type: "text" },
  { key: "flight_date", label: "Flight Date", type: "text" },
  { key: "accommodation", label: "Accommodation", type: "text" },
  { key: "insurance", label: "Insurance (start date)", type: "text" },
  { key: "insurance_expiry", label: "Insurance Expiry", type: "text" },
  { key: "skills_pass", label: "Skills pass", type: "select", options: ["", "Yes", "No", "Not required"] },
  { key: "pre_departure", label: "Pre-Departure course", type: "select", options: ["", "Yes", "No", "Not required"] },
  { key: "job_title", label: "Job title", type: "text" },
  { key: "employer", label: "Employer", type: "text" },
  { key: "result", label: "result", type: "select", options: ["", "passed", "email sent", "email received", "refused", "sent to interview"] },
  { key: "comments", label: "Comments", type: "textarea", full: true },
  { key: "uncertain", label: "Uncertain about", type: "textarea", full: true },
];

// Malta Central Visa Unit — "Documentation Required for Employment Visa" checklist
// (visas of more than 90 days), version 3 dated 18.03.2025.
const CHECKLIST_ITEMS = [
  { id: "visa_form", label: "Visa Application Form",
    criteria: "Fully filled and signed by the applicant." },
  { id: "passport", label: "Passport",
    criteria: "Minimum validity of 8 months from the date of the visa application." },
  { id: "passport_photo", label: "Passport photo",
    criteria: "Meets ICAO standards (recent, plain light background, neutral expression, correct size/head proportions)." },
  { id: "aip_letter", label: "Approval in Principle (AIP) letter",
    criteria: "Present, and the visa is being applied for within 60 days of the AIP letter's issuance date." },
  { id: "vfs_appointment", label: "VFS Appointment Letter",
    criteria: "Present." },
  { id: "flight_tickets", label: "Prospective flight tickets",
    criteria: "Full itinerary provided, clearly showing the applicant's name, flight date, and all stops — preferably transiting outside the Schengen area." },
  { id: "insurance", label: "Medical & travel insurance",
    criteria: "Valid for the Schengen area; minimum €30,000 medical coverage; minimum 180 consecutive days, valid at least from the point of submission of the visa application; shows name, surname, and passport number; coverage is not restricted or linked to the applicant's place of residence and does not restrict the applicant to departing only from the country where the policy was issued. If the certificate doesn't show all of this, a table of benefits is required to confirm it." },
  { id: "accommodation", label: "Proof of prospective accommodation",
    criteria: "Matches the applicable accommodation type: (a) employer-provided free accommodation — notarised/lawyer-signed declaration by the host, a copy of the host's ID card, and (if a secondary address) proof of the host's link to that residence; OR (b) rented accommodation — a registered lease agreement signed by both parties stating duration, home address, applicant's name, and rent; OR (c) hotel/short-term/vacation rental — a booking for a minimum of 14 consecutive nights from the date of prospective arrival in Malta." },
  { id: "skills_pass", label: "Skills Pass (if applicable)",
    criteria: "Required only for applicants working directly or indirectly in the tourism and hospitality sector — Skills Pass Part 1 and Part 2 completion certificates issued by the Institute of Tourism Studies. Not applicable outside that sector." },
  { id: "fees", label: "Visa application fee",
    criteria: "€150 standard / €250 extended. This is a payment made by credit/visa card, not a document — always mark this item \"Not applicable\" since it cannot be verified from uploaded documents." },
];

const GEMINI_MODEL = "gemini-3.6-flash";

const state = {
  files: [],       // {id, file}
  record: null,    // last extracted record (object keyed by FIELDS[].key), plus .checklist
  editingCaseId: null, // set while editing a saved case log entry, so Save updates it instead of adding a new one
  log: JSON.parse(localStorage.getItem("case_log") || "[]")
    .map(c => c.id ? c : { ...c, id: crypto.randomUUID() }), // backfill ids for entries saved before edit support existed
};
localStorage.setItem("case_log", JSON.stringify(state.log));

const el = (id) => document.getElementById(id);
const fileListEl = el("fileList");
const fileCountEl = el("fileCount");
const extractBtn = el("extractBtn");
const statusEl = el("status");
const recordBody = el("recordBody");
const recordTag = el("recordTag");
const logBody = el("logBody");
const logCount = el("logCount");

// ---------- API key / engine persistence ----------
const apiKeyInput = el("apiKey");
apiKeyInput.value = localStorage.getItem("case_register_gemini_key") || "";
apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("case_register_gemini_key", apiKeyInput.value.trim());
});

const engineModeEl = el("engineMode");
const homeUrlInput = el("homeUrl");
const homeTokenInput = el("homeToken");
const engineTagEl = el("engineTag");
const homeActiveTag = el("homeActiveTag");
const geminiActiveTag = el("geminiActiveTag");

engineModeEl.value = localStorage.getItem("case_register_engine") || "home";
homeUrlInput.value = localStorage.getItem("case_register_home_url") || "";
homeTokenInput.value = localStorage.getItem("case_register_home_token") || "";

// Both credential rows stay visible in Options at all times (so there's
// always somewhere to enter either one) — only the "Active" tag and the
// compact intake-panel tag reflect which engine is actually in use.
function syncEngineRows() {
  const isHome = engineModeEl.value === "home";
  engineTagEl.textContent = isHome ? "Home server" : "Gemini";
  homeActiveTag.hidden = !isHome;
  geminiActiveTag.hidden = isHome;
}
syncEngineRows();

engineModeEl.addEventListener("change", () => {
  localStorage.setItem("case_register_engine", engineModeEl.value);
  syncEngineRows();
});
homeUrlInput.addEventListener("input", () => {
  localStorage.setItem("case_register_home_url", homeUrlInput.value.trim());
});
homeTokenInput.addEventListener("input", () => {
  localStorage.setItem("case_register_home_token", homeTokenInput.value.trim());
});

// ---------- Theme & accent color ----------
const themeOptionRadios = document.querySelectorAll('input[name="themeOption"]');

const ACCENT_PRESETS = [
  { id: "red", name: "Stamp Red",
    light: { accent: "#B23A2F", accentDark: "#8C2C22", accentBg: "#FBF1EF" },
    dark: { accent: "#E2685C", accentDark: "#B23A2F", accentBg: "rgba(226,104,92,.12)" } },
  { id: "navy", name: "Navy Blue",
    light: { accent: "#2A4E8C", accentDark: "#1E3A6B", accentBg: "#EAF0FA" },
    dark: { accent: "#6E9EEB", accentDark: "#3B5FA3", accentBg: "rgba(110,158,235,.12)" } },
  { id: "plum", name: "Plum",
    light: { accent: "#7A3B6B", accentDark: "#5C2B50", accentBg: "#F6EDF3" },
    dark: { accent: "#C97FB5", accentDark: "#8C4F79", accentBg: "rgba(201,127,181,.12)" } },
  { id: "teal", name: "Teal",
    light: { accent: "#1F7A72", accentDark: "#155A54", accentBg: "#E9F5F3" },
    dark: { accent: "#5FC4B8", accentDark: "#2F8C82", accentBg: "rgba(95,196,184,.12)" } },
  { id: "charcoal", name: "Charcoal",
    light: { accent: "#3A4652", accentDark: "#252E38", accentBg: "#EEF0F2" },
    dark: { accent: "#9FB0BD", accentDark: "#5C6B78", accentBg: "rgba(159,176,189,.12)" } },
];

const accentPickerBtn = el("accentPickerBtn");
const accentMenu = el("accentMenu");
const accentSwatchCurrent = el("accentSwatchCurrent");
const accentNameCurrent = el("accentNameCurrent");
let currentAccentId = localStorage.getItem("case_register_accent") || "red";

function applyAccent(id) {
  const preset = ACCENT_PRESETS.find(p => p.id === id) || ACCENT_PRESETS[0];
  currentAccentId = preset.id;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const vals = isDark ? preset.dark : preset.light;
  document.documentElement.style.setProperty("--accent", vals.accent);
  document.documentElement.style.setProperty("--accent-dark", vals.accentDark);
  document.documentElement.style.setProperty("--accent-bg", vals.accentBg);
  localStorage.setItem("case_register_accent", preset.id);
  renderAccentPicker();
}

function renderAccentPicker() {
  const preset = ACCENT_PRESETS.find(p => p.id === currentAccentId) || ACCENT_PRESETS[0];
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  accentSwatchCurrent.style.setProperty("--swatch-color", (isDark ? preset.dark : preset.light).accent);
  accentNameCurrent.textContent = preset.name;

  accentMenu.innerHTML = "";
  ACCENT_PRESETS.forEach(p => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "accent-option" + (p.id === currentAccentId ? " active" : "");
    btn.setAttribute("role", "menuitem");
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.setProperty("--swatch-color", (isDark ? p.dark : p.light).accent);
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(" " + p.name));
    btn.addEventListener("click", () => {
      applyAccent(p.id);
      accentMenu.setAttribute("hidden", "");
      accentPickerBtn.setAttribute("aria-expanded", "false");
    });
    accentMenu.appendChild(btn);
  });
}

accentPickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = accentMenu.hasAttribute("hidden");
  if (willOpen) accentMenu.removeAttribute("hidden"); else accentMenu.setAttribute("hidden", "");
  accentPickerBtn.setAttribute("aria-expanded", String(willOpen));
});
document.addEventListener("click", (e) => {
  if (!accentMenu.hasAttribute("hidden") && !accentMenu.contains(e.target) && !accentPickerBtn.contains(e.target)) {
    accentMenu.setAttribute("hidden", "");
    accentPickerBtn.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !accentMenu.hasAttribute("hidden")) {
    accentMenu.setAttribute("hidden", "");
    accentPickerBtn.setAttribute("aria-expanded", "false");
  }
});

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("case_register_theme", theme);
  themeOptionRadios.forEach(r => { r.checked = r.value === theme; });
  applyAccent(currentAccentId);
}

el("themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

themeOptionRadios.forEach(r => {
  r.addEventListener("change", () => { if (r.checked) applyTheme(r.value); });
});

applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

// ---------- Apps menu / view switching ----------
const VIEW_META = {
  intake: {
    eyebrow: "Case Register · Document Extraction",
    title: "Employment case intake",
    subtitle: "Upload supporting documents for a case (passport, employer letter, appointment or flight confirmation). The register reads them and drafts the case record below for you to check before export.",
  },
  email: {
    eyebrow: "Case Register · Correspondence",
    title: "Email writer",
    subtitle: "Draft a document-revision request from the current case's findings, or write one from scratch.",
  },
  options: {
    eyebrow: "Case Register · Settings",
    title: "Options",
    subtitle: "Theme, extraction engine, and API key — everything the other views need to run.",
  },
};

const viewIntakeEl = el("view-intake");
const viewEmailEl = el("view-email");
const viewOptionsEl = el("view-options");
const menuToggle = el("menuToggle");
const appMenu = el("appMenu");
let currentView = "intake";
let emailAutoLoaded = false;

function switchView(name) {
  currentView = name;
  viewIntakeEl.hidden = name !== "intake";
  viewEmailEl.hidden = name !== "email";
  viewOptionsEl.hidden = name !== "options";

  const meta = VIEW_META[name];
  el("viewEyebrow").textContent = meta.eyebrow;
  el("viewTitle").textContent = meta.title;
  el("viewSubtitle").textContent = meta.subtitle;

  appMenu.querySelectorAll("button[data-view]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });

  if (name === "email" && !emailAutoLoaded) {
    emailAutoLoaded = true;
    loadCaseIntoEmail();
  }
}

menuToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = appMenu.hasAttribute("hidden");
  if (willOpen) appMenu.removeAttribute("hidden"); else appMenu.setAttribute("hidden", "");
  menuToggle.setAttribute("aria-expanded", String(willOpen));
});

appMenu.querySelectorAll("button[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    switchView(btn.dataset.view);
    appMenu.setAttribute("hidden", "");
    menuToggle.setAttribute("aria-expanded", "false");
  });
});

document.addEventListener("click", (e) => {
  if (!appMenu.hasAttribute("hidden") && !appMenu.contains(e.target) && e.target !== menuToggle) {
    appMenu.setAttribute("hidden", "");
    menuToggle.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !appMenu.hasAttribute("hidden")) {
    appMenu.setAttribute("hidden", "");
    menuToggle.setAttribute("aria-expanded", "false");
  }
});

el("openOptionsBtn").addEventListener("click", () => switchView("options"));

// ---------- File intake ----------
const drop = el("drop");
const fileInput = el("fileInput");

drop.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach(evt =>
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add("drag"); })
);
["dragleave", "drop"].forEach(evt =>
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => addFiles(e.target.files));

function addFiles(fileListObj) {
  Array.from(fileListObj).forEach((file) => {
    state.files.push({ id: crypto.randomUUID(), file });
  });
  renderFileList();
}

function renderFileList() {
  fileListEl.innerHTML = "";
  state.files.forEach(({ id, file }) => {
    const li = document.createElement("li");
    const kb = (file.size / 1024).toFixed(0);
    li.innerHTML = `<span class="name">${escapeHtml(file.name)}</span><span>${kb} kb</span>`;
    const rm = document.createElement("button");
    rm.textContent = "remove";
    rm.onclick = () => { state.files = state.files.filter(f => f.id !== id); renderFileList(); };
    li.appendChild(rm);
    fileListEl.appendChild(li);
  });
  fileCountEl.textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
  extractBtn.disabled = state.files.length === 0;
}

el("clearBtn").addEventListener("click", () => { state.files = []; renderFileList(); });

// ---------- Extraction ----------
extractBtn.addEventListener("click", runExtraction);

async function runExtraction() {
  if (engineModeEl.value === "home") {
    return runExtractionViaHomeServer();
  }
  return runExtractionViaGemini();
}

async function runExtractionViaHomeServer() {
  const url = homeUrlInput.value.trim();
  const token = homeTokenInput.value.trim();
  if (!url) {
    setStatus("Enter your home server URL first.", true);
    return;
  }
  if (!token) {
    setStatus("Enter your home server token first.", true);
    return;
  }
  extractBtn.disabled = true;
  setStatus("Sending documents to home server…");

  try {
    const formData = new FormData();
    state.files.forEach(({ file }) => formData.append("files", file, file.name));

    const resp = await fetch(`${url.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `Home server error ${resp.status}`);
    }

    const parsed = await resp.json();
    parsed.checklist = normalizeChecklist(parsed.checklist);
    state.record = parsed;
    renderRecord(true);
    setStatus(`Extracted from ${state.files.length} document${state.files.length === 1 ? "" : "s"} (home server). Review before saving.`);
  } catch (err) {
    console.error(err);
    const msg = /Failed to fetch|NetworkError/i.test(err.message || "")
      ? "Can't reach the home server — check it's on and connected, or switch to Gemini fallback above."
      : (err.message || "Extraction failed.");
    setStatus(msg, true);
  } finally {
    extractBtn.disabled = state.files.length === 0;
  }
}

async function runExtractionViaGemini() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter your Gemini API key first.", true);
    return;
  }
  extractBtn.disabled = true;
  setStatus("Reading documents…");

  try {
    const parts = [];
    for (const { file } of state.files) {
      if (file.type === "application/pdf") {
        const text = await extractPdfText(file);
        if (text.trim().length > 40) {
          parts.push({ text: `--- Document: ${file.name} (PDF text) ---\n${text}` });
        } else {
          // no embedded text layer (likely scanned) — send the PDF itself,
          // Gemini reads PDFs natively including scanned pages
          const base64 = await fileToBase64(file);
          parts.push({ text: `--- Document: ${file.name} (scanned PDF) ---` });
          parts.push({ inline_data: { mime_type: "application/pdf", data: base64 } });
        }
      } else if (file.type.startsWith("image/")) {
        const base64 = await fileToBase64(file);
        parts.push({ text: `--- Document: ${file.name} (image) ---` });
        parts.push({ inline_data: { mime_type: file.type, data: base64 } });
      }
    }

    setStatus("Extracting fields…");

    const instruction = `You are helping a visa case officer draft a case record from supporting documents.
Read all the documents provided (text and/or images — passport pages, employer letters, appointment or flight confirmations, insurance certificates, etc.).
Extract only what these documents actually state. Return ONLY a JSON object, no markdown fences, no commentary, with exactly these keys:
name, surname, gender, passport_number, date_appointment, aip_date, flight_date, accommodation, insurance, insurance_expiry, skills_pass, pre_departure, job_title, employer, result, comments, uncertain.
- gender must be "Male", "Female", or "" if unclear.
- skills_pass and pre_departure are TWO SEPARATE things that are easy to confuse — read carefully:
  - skills_pass = "Yes" if you see any "Skills Pass" branded certificate — the interlocking diamond/arrow Skills Pass logo and/or "Skills Pass" wording in the title (e.g. "Certificate of Skills Pass Achievement"). This can be issued by different bodies with different layouts (e.g. "Skills Pass Malta" with an ISSUE DATE/RECIPIENT/ISSUER layout, or "Institute of Tourism Studies - Malta" with a Full Name/Candidate Number/Job Family/Level layout, or others) — issuer and layout vary, the Skills Pass branding is the constant. Note: its batch or course name may itself contain the word "predeparture" (e.g. "Phase 2 predeparture batch 11") — that is just naming a training session/batch, it does NOT mean this document belongs to pre_departure. If the document has Skills Pass branding, set skills_pass, not pre_departure, regardless of that wording.
  - pre_departure = "Yes" only if you see a "PRE-DEPARTURE COURSE — Certificate of Achievement" issued by the Government of Malta (Ministry for Home Affairs, Security and Employment), listing specific course topics (e.g. language, hygiene, culture, transport). If you see this document type, set pre_departure, not skills_pass.
  - Each is "No" or "Not required" only if stated as such in a document; "" if neither document type is present at all.
- result must be one of "passed", "email sent", "email received", "refused", "sent to interview", or "" if not stated.
- insurance is the insurance policy START DATE (matches the format of a date field in the source form) — do NOT put the insurance company/provider name here, only a date.
- insurance_expiry is the insurance policy EXPIRY date, same rule.
- Dates: use whatever format appears in the source document; do not invent a date that isn't present.
- If a field is not present in any document, return an empty string for it — never guess or fabricate.
- comments: a short note on anything relevant you noticed (e.g. discrepancies, missing documents) — not a restatement of the other fields.
- uncertain: separate from comments. List each field you were NOT confident about and why — e.g. handwriting was hard to read, two documents gave conflicting dates, a value was inferred rather than directly stated. Leave this empty ("") only if you're confident in every field you filled in.

Additionally, check the uploaded documents against Malta's Central Visa Unit "Documentation Required for Employment Visa" checklist below. Return a "checklist" array in the JSON with exactly one entry per item, in this order, each an object with keys "id", "status", "note":
${CHECKLIST_ITEMS.map((c, i) => `${i + 1}. id="${c.id}" — ${c.label}: ${c.criteria}`).join("\n")}

For each item, set "status" to exactly one of:
- "Compliant": a document satisfying this item is present and meets the stated criteria.
- "Non-compliant": a relevant document is present but fails to meet the stated criteria — say specifically why in "note" (e.g. which figure, date, or detail falls short).
- "Missing": no document addressing this item was provided at all.
- "Not applicable": the item doesn't apply to this case (e.g. skills_pass when the applicant isn't in tourism/hospitality; the fees item, which is always "Not applicable" since it's a payment, not a document).
"note" should be one short sentence citing the specific shortfall for "Non-compliant", or a brief reason for "Missing"/"Not applicable". Leave it empty ("") for "Compliant" unless there's a minor caveat worth flagging. Base every verdict only on what the documents actually show — never assume compliance for a document that wasn't provided.`;

    const body = {
      contents: [{ role: "user", parts: [{ text: instruction }, ...parts] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API error ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("") || "";
    if (!rawText) throw new Error("No text in response — the model may have blocked the content or returned nothing.");

    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    parsed.checklist = normalizeChecklist(parsed.checklist);

    state.record = parsed;
    renderRecord(true);
    setStatus(`Extracted from ${state.files.length} document${state.files.length === 1 ? "" : "s"}. Review before saving.`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Extraction failed.", true);
  } finally {
    extractBtn.disabled = state.files.length === 0;
  }
}

function extractPdfText(file) {
  if (typeof pdfjsLib === "undefined") {
    return Promise.reject(new Error("PDF reader (pdf.js) failed to load from its CDN — check your network/ad-blocker and reload the page. Image files still work."));
  }
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(reader.result) }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        resolve(text);
      } catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const CHECKLIST_STATUSES = ["Compliant", "Non-compliant", "Missing", "Not applicable"];

function normalizeChecklist(raw) {
  const byId = new Map((Array.isArray(raw) ? raw : []).map(c => [c && c.id, c]));
  return CHECKLIST_ITEMS.map(item => {
    const found = byId.get(item.id) || {};
    const status = CHECKLIST_STATUSES.includes(found.status) ? found.status : "Missing";
    return { id: item.id, status, note: (found.note || "").toString() };
  });
}

function checklistBadgeClass(status) {
  return { Compliant: "ok", "Non-compliant": "err", Missing: "warn", "Not applicable": "muted" }[status] || "muted";
}

// ---------- Checklist compliance ----------
const checklistBody = el("checklistBody");
const checklistTag = el("checklistTag");

function renderChecklist(checklist) {
  if (!checklist || !checklist.length) {
    checklistTag.textContent = "Not checked";
    checklistTag.className = "tag";
    checklistBody.innerHTML = `<div class="empty-state"><img class="mark" src="icons/logo.png" alt="">Compliance against the Employment Visa document checklist will appear here after extraction.</div>`;
    return;
  }

  const flagged = checklist.filter(c => c.status === "Non-compliant" || c.status === "Missing").length;
  checklistTag.textContent = flagged === 0 ? "All clear" : `${flagged} issue${flagged === 1 ? "" : "s"}`;
  checklistTag.className = "tag " + (flagged === 0 ? "ok" : "err");

  const list = document.createElement("div");
  list.className = "checklist-list";
  checklist.forEach(c => {
    const item = CHECKLIST_ITEMS.find(i => i.id === c.id);
    const row = document.createElement("div");
    row.className = "checklist-item";
    row.innerHTML = `
      <div class="checklist-item-head">
        <span class="checklist-label">${escapeHtml(item ? item.label : c.id)}</span>
        <span class="badge ${checklistBadgeClass(c.status)}">${escapeHtml(c.status)}</span>
      </div>
      ${c.note ? `<div class="checklist-note">${escapeHtml(c.note)}</div>` : ""}
    `;
    list.appendChild(row);
  });
  checklistBody.innerHTML = "";
  checklistBody.appendChild(list);
}

// ---------- Draft record UI ----------
function renderRecord(justExtracted) {
  renderChecklist(state.record ? state.record.checklist : null);

  if (state.record) {
    recordTag.textContent = state.editingCaseId
      ? "Editing saved case"
      : (state.record.uncertain || "").trim() ? "Draft — check uncertainty notes" : "Draft — review";
  } else {
    recordTag.textContent = "Unverified";
  }
  if (!state.record) {
    recordBody.innerHTML = `<div class="empty-state"><img class="mark" src="icons/logo.png" alt="">Extracted fields will appear here for review once documents are processed.</div>`;
    return;
  }

  const wrap = document.createElement("div");
  if (justExtracted) wrap.className = "stamped";

  const grid = document.createElement("div");
  grid.className = "fields-grid";

  FIELDS.forEach(f => {
    const field = document.createElement("div");
    field.className = "field" + (f.full ? " full" : "");
    const label = document.createElement("label");
    label.textContent = f.label;
    field.appendChild(label);

    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      f.options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt || "—";
        if ((state.record[f.key] || "") === opt) o.selected = true;
        input.appendChild(o);
      });
    } else if (f.type === "textarea") {
      input = document.createElement("textarea");
      input.value = state.record[f.key] || "";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = state.record[f.key] || "";
    }
    input.addEventListener("input", () => { state.record[f.key] = input.value; });
    field.appendChild(input);
    grid.appendChild(field);
  });

  wrap.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "actions";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn";
  saveBtn.textContent = state.editingCaseId ? "Update case" : "Save to case log";
  saveBtn.onclick = saveToLog;
  const discardBtn = document.createElement("button");
  discardBtn.className = "btn secondary";
  discardBtn.textContent = state.editingCaseId ? "Cancel edit" : "Discard draft";
  discardBtn.onclick = () => { state.record = null; state.editingCaseId = null; renderRecord(false); };
  actions.appendChild(saveBtn);
  actions.appendChild(discardBtn);
  wrap.appendChild(actions);

  recordBody.innerHTML = "";
  recordBody.appendChild(wrap);
}

function saveToLog() {
  const wasEditing = !!state.editingCaseId;
  if (wasEditing) {
    const idx = state.log.findIndex(c => c.id === state.editingCaseId);
    if (idx !== -1) {
      state.log[idx] = { ...state.record, id: state.editingCaseId, savedAt: state.log[idx].savedAt, updatedAt: new Date().toISOString() };
    } else {
      // the entry was removed from the log while it was being edited — save it as a new one instead of losing the edits
      state.log.push({ ...state.record, id: crypto.randomUUID(), savedAt: new Date().toISOString() });
    }
  } else {
    state.log.push({ ...state.record, id: crypto.randomUUID(), savedAt: new Date().toISOString() });
  }
  localStorage.setItem("case_log", JSON.stringify(state.log));
  state.record = null;
  state.editingCaseId = null;
  state.files = [];
  renderFileList();
  renderRecord(false);
  renderLog();
  setStatus(wasEditing ? "Case updated." : "Saved to case log.");
}

function editCaseFromLog(idx) {
  const entry = state.log[idx];
  if (!entry) return;
  const { id, savedAt, updatedAt, ...recordFields } = entry;
  state.record = recordFields;
  state.editingCaseId = id;
  state.files = [];
  renderFileList();
  renderRecord(false);
  switchView("intake");
  setStatus(`Editing ${(entry.name || entry.surname) ? `${entry.name || ""} ${entry.surname || ""}`.trim() : "case"} — make your changes, then "Update case" (or "Cancel edit" to leave it as-is).`);
}

// ---------- Case log ----------
function renderLog() {
  logCount.textContent = `${state.log.length} case${state.log.length === 1 ? "" : "s"}`;
  if (state.log.length === 0) {
    logBody.innerHTML = `<tr><td colspan="12" style="color:var(--muted); text-align:center;">No cases logged yet.</td></tr>`;
    return;
  }
  logBody.innerHTML = "";
  state.log.forEach((rec, idx) => {
    const tr = document.createElement("tr");
    const flagged = (rec.checklist || []).filter(c => c.status === "Non-compliant" || c.status === "Missing").length;
    const checklistCell = !rec.checklist || !rec.checklist.length
      ? `<span class="badge muted">n/a</span>`
      : flagged === 0
        ? `<span class="badge ok">clear</span>`
        : `<span class="badge err">${flagged} issue${flagged === 1 ? "" : "s"}</span>`;
    tr.innerHTML = `
      <td>${escapeHtml(rec.name || "")}</td>
      <td>${escapeHtml(rec.surname || "")}</td>
      <td>${escapeHtml(rec.gender || "")}</td>
      <td>${escapeHtml(rec.passport_number || "")}</td>
      <td>${escapeHtml(rec.date_appointment || "")}</td>
      <td>${escapeHtml(rec.aip_date || "")}</td>
      <td>${escapeHtml(rec.flight_date || "")}</td>
      <td>${escapeHtml(rec.employer || "")}</td>
      <td>${escapeHtml(rec.job_title || "")}</td>
      <td>${escapeHtml(rec.result || "")}</td>
      <td>${checklistCell}</td>
      <td>
        <button class="row-edit" data-idx="${idx}">edit</button>
        <button class="row-del" data-idx="${idx}">remove</button>
      </td>
    `;
    logBody.appendChild(tr);
  });
  logBody.querySelectorAll(".row-edit").forEach(btn => {
    btn.addEventListener("click", () => editCaseFromLog(Number(btn.dataset.idx)));
  });
  logBody.querySelectorAll(".row-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (state.log[idx] && state.log[idx].id === state.editingCaseId) {
        state.record = null;
        state.editingCaseId = null;
        renderRecord(false);
      }
      state.log.splice(idx, 1);
      localStorage.setItem("case_log", JSON.stringify(state.log));
      renderLog();
    });
  });
}

el("exportBtn").addEventListener("click", () => {
  if (state.log.length === 0) { setStatus("No cases to export yet.", true); return; }
  const keys = FIELDS.map(f => f.key);
  const header = [...keys, "checklist_issues"].join(",");
  const rows = state.log.map(rec => {
    const base = keys.map(k => csvCell(rec[k] || "")).join(",");
    const issues = (rec.checklist || [])
      .filter(c => c.status === "Non-compliant" || c.status === "Missing")
      .map(c => {
        const item = CHECKLIST_ITEMS.find(i => i.id === c.id);
        const label = item ? item.label : c.id;
        return c.note ? `${label}: ${c.note}` : `${label} (${c.status})`;
      })
      .join("; ");
    return `${base},${csvCell(issues)}`;
  });
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `case-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

const logStatusEl = el("logStatus");
function setLogStatus(msg, isErr) {
  logStatusEl.textContent = msg;
  logStatusEl.className = "status" + (isErr ? " err" : "");
}

// ---------- Full JSON backup/restore ----------
// CSV export drops the checklist verdicts and can't be re-imported; this
// keeps a full-fidelity copy of the case log (including ids, so re-importing
// the same backup twice doesn't create duplicates).
el("exportJsonBtn").addEventListener("click", () => {
  if (state.log.length === 0) { setLogStatus("No cases to export yet.", true); return; }
  const payload = {
    format: "case-register-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    log: state.log,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `case-log-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setLogStatus(`Exported ${state.log.length} case${state.log.length === 1 ? "" : "s"} as a JSON backup.`);
});

const importJsonInput = el("importJsonInput");
el("importJsonBtn").addEventListener("click", () => importJsonInput.click());

importJsonInput.addEventListener("change", () => {
  const file = importJsonInput.files[0];
  importJsonInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed.log) ? parsed.log : null;
      if (!incoming) throw new Error("This file doesn't look like a case log backup — expected a JSON array or an object with a \"log\" array.");

      const existingIds = new Set(state.log.map(c => c.id));
      let added = 0, skipped = 0;
      incoming.forEach(entry => {
        if (!entry || typeof entry !== "object") { skipped++; return; }
        const withId = entry.id ? entry : { ...entry, id: crypto.randomUUID() };
        if (existingIds.has(withId.id)) { skipped++; return; }
        withId.checklist = normalizeChecklist(withId.checklist);
        state.log.push(withId);
        existingIds.add(withId.id);
        added++;
      });

      localStorage.setItem("case_log", JSON.stringify(state.log));
      renderLog();
      setLogStatus(`Imported ${added} case${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already present, skipped)` : ""}.`);
    } catch (err) {
      console.error(err);
      setLogStatus(err.message || "Couldn't read that file as a case log backup.", true);
    }
  };
  reader.onerror = () => setLogStatus("Couldn't read that file.", true);
  reader.readAsText(file);
});

function csvCell(v) {
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (isErr ? " err" : "");
}

// ---------- Email writer ----------
// Ported from the standalone CVU Revision Email Writer, wired to read the
// current case's extracted fields and checklist verdicts.
const CHECKLIST_LINKS = {
  sport: "https://identita.gov.mt/wp-content/uploads/2025/07/12.-Sports-Trials-Checklist.pdf",
  student: "https://identita.gov.mt/wp-content/uploads/2025/08/03a.-List-of-Required-Documents-Student_National_Visa.pdf",
  employment: "https://identita.gov.mt/wp-content/uploads/2025/06/01.-List-of-Required-Documents-EMPLOYMENT-VISA.pdf",
};

const emailApplicantName = el("emailApplicantName");
const emailPassportNumber = el("emailPassportNumber");
const emailSalutation = el("emailSalutation");
const emailAppTypeRadios = document.querySelectorAll('input[name="emailAppType"]');
const emailBulletsContainer = el("emailBulletsContainer");
const emailAddBulletBtn = el("emailAddBulletBtn");
const emailSubjectReadout = el("emailSubjectReadout");
const emailOutput = el("emailOutput");
const emailCopySubjectBtn = el("emailCopySubjectBtn");
const emailCopyBodyBtn = el("emailCopyBodyBtn");
const emailCaseTag = el("emailCaseTag");
const emailLoadCaseBtn = el("emailLoadCaseBtn");
const emailGenerateFindingsBtn = el("emailGenerateFindingsBtn");
const emailStatusEl = el("emailStatus");

function setEmailStatus(msg, isErr) {
  emailStatusEl.textContent = msg;
  emailStatusEl.className = "status" + (isErr ? " err" : "");
}

function getEmailAppType() {
  return document.querySelector('input[name="emailAppType"]:checked').value;
}

function autoResizeTextarea(node) {
  node.style.height = "auto";
  node.style.height = node.scrollHeight + "px";
}

function createEmailBulletRow(value) {
  const row = document.createElement("div");
  row.className = "bullet-row";

  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = "Describe the issue found...";
  input.value = value || "";
  input.addEventListener("input", () => { autoResizeTextarea(input); renderEmail(); });

  const removeBtn = document.createElement("button");
  removeBtn.className = "icon-btn";
  removeBtn.type = "button";
  removeBtn.innerHTML = "&times;";
  removeBtn.title = "Remove";
  removeBtn.addEventListener("click", () => { row.remove(); renderEmail(); });

  row.appendChild(input);
  row.appendChild(removeBtn);
  requestAnimationFrame(() => autoResizeTextarea(input));
  return row;
}

function addEmailBullet(value) {
  emailBulletsContainer.appendChild(createEmailBulletRow(value));
}

emailAddBulletBtn.addEventListener("click", () => { addEmailBullet(); renderEmail(); });
emailAppTypeRadios.forEach(r => r.addEventListener("change", renderEmail));
[emailApplicantName, emailPassportNumber, emailSalutation].forEach(input =>
  input.addEventListener("input", renderEmail)
);

function getEmailBulletValues() {
  return Array.from(emailBulletsContainer.querySelectorAll("textarea"))
    .map(i => i.value.trim())
    .filter(v => v.length > 0);
}

function buildEmailSubject() {
  const name = emailApplicantName.value.trim();
  const passport = emailPassportNumber.value.trim();
  if (!name && !passport) return "";
  let subj = "Visa Application Revision Required";
  if (name) subj += ` – ${name}`;
  if (passport) subj += ` (Passport No. ${passport})`;
  return subj;
}

function buildEmailBody() {
  const name = emailApplicantName.value.trim();
  const title = emailSalutation.value.trim();
  let greeting;
  if (title && name) greeting = `${title} ${name}`;
  else if (name) greeting = name;
  else if (title) greeting = title;
  else greeting = "XXXXXXXX";

  const bullets = getEmailBulletValues();
  const bulletText = bullets.length
    ? bullets.map(b => `* ${b}`).join("\n\n \n\n")
    : "* XXXXXXXX \n\n \n\n* XXXXXXXX \n\n \n\n* XXXXXXXX \n\n \n\n* XXXXXXXX";

  const appType = getEmailAppType();
  const link = CHECKLIST_LINKS[appType];
  const subjectReminder = appType === "employment"
    ? "\n\nAny correspondence should include name and passport number of applicant in the subject."
    : "";

  return `Dear ${greeting},

Whilst reviewing your application it was noted that:

${bulletText}

Kindly provide us with a revised document that meets CVU's checklist requirements as found on the following link ${link}

Your feedback is required within five working days from the date of this email. Kindly note that no reminders will be sent and that no further revisions will be allowed.

If you fail to provide the necessary requested information within this timeframe, your visa application outcome will be negatively impacted.${subjectReminder}

Kind Regards,`;
}

function renderEmail() {
  const subject = buildEmailSubject();
  emailSubjectReadout.textContent = subject || "Subject will appear here";
  emailOutput.value = buildEmailBody();
}

function flashCopied(btn) {
  const original = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("ok-flash");
  setTimeout(() => { btn.textContent = original; btn.classList.remove("ok-flash"); }, 1200);
}

emailCopyBodyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(emailOutput.value).then(() => flashCopied(emailCopyBodyBtn));
});
emailCopySubjectBtn.addEventListener("click", () => {
  const subj = buildEmailSubject();
  if (!subj) return;
  navigator.clipboard.writeText(subj).then(() => flashCopied(emailCopySubjectBtn));
});

function describeChecklistFinding(entry) {
  const item = CHECKLIST_ITEMS.find(i => i.id === entry.id);
  const label = item ? item.label : entry.id;
  if (entry.status === "Missing") {
    return `${label} was not included in the documents submitted.`;
  }
  return `${label}: ${entry.note || "does not meet the checklist requirements."}`;
}

function loadCaseIntoEmail() {
  const rec = state.record;
  const fullName = rec ? [rec.name, rec.surname].filter(Boolean).join(" ") : "";
  emailApplicantName.value = fullName;
  emailPassportNumber.value = rec ? (rec.passport_number || "") : "";
  emailSalutation.value = rec && rec.gender === "Male" ? "Mr." : rec && rec.gender === "Female" ? "Ms." : "";

  emailBulletsContainer.innerHTML = "";
  const issues = rec ? (rec.checklist || []).filter(c => c.status === "Non-compliant" || c.status === "Missing") : [];
  if (issues.length) {
    issues.forEach(entry => addEmailBullet(describeChecklistFinding(entry)));
  } else {
    for (let i = 0; i < 4; i++) addEmailBullet();
  }

  if (rec) {
    const fileNote = state.files.length ? `, ${state.files.length} document${state.files.length === 1 ? "" : "s"} attached` : "";
    emailCaseTag.textContent = `${fullName || "Case"} loaded${fileNote}`;
    emailCaseTag.className = "tag ok";
  } else {
    emailCaseTag.textContent = "No case loaded";
    emailCaseTag.className = "tag";
  }

  renderEmail();
}

emailLoadCaseBtn.addEventListener("click", loadCaseIntoEmail);

function getCurrentChecklistIssues() {
  const rec = state.record;
  return rec ? (rec.checklist || []).filter(c => c.status === "Non-compliant" || c.status === "Missing") : [];
}

function issuesForPrompt(issues) {
  return issues.map(entry => {
    const item = CHECKLIST_ITEMS.find(i => i.id === entry.id);
    return { id: entry.id, label: item ? item.label : entry.id, status: entry.status, note: entry.note || "" };
  });
}

async function generateFindingsWithAI() {
  const issues = getCurrentChecklistIssues();
  if (!state.record) {
    setEmailStatus("Load a case first (or add findings manually).", true);
    return;
  }
  if (!issues.length) {
    setEmailStatus("No compliance issues on the current case — nothing to generate wording for.", true);
    return;
  }

  emailGenerateFindingsBtn.disabled = true;
  setEmailStatus("Generating findings…");

  try {
    const applicant = {
      name: emailApplicantName.value.trim(),
      passport_number: emailPassportNumber.value.trim(),
    };
    const promptIssues = issuesForPrompt(issues);
    let findings;

    if (engineModeEl.value === "home") {
      const url = homeUrlInput.value.trim();
      const token = homeTokenInput.value.trim();
      if (!url) throw new Error("Enter your home server URL in Options first.");
      if (!token) throw new Error("Enter your home server token in Options first.");

      const resp = await fetch(`${url.replace(/\/$/, "")}/findings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ applicant, issues: promptIssues }),
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Home server error ${resp.status} (does it implement /findings?)`);
      }
      const data = await resp.json();
      findings = Array.isArray(data.findings) ? data.findings : [];
    } else {
      const key = apiKeyInput.value.trim();
      if (!key) throw new Error("Enter your Gemini API key in Options first.");

      const issuesText = promptIssues
        .map((e, i) => `${i + 1}. ${e.label} — status: ${e.status}${e.note ? `; note: ${e.note}` : ""}`)
        .join("\n");
      const prompt = `You are drafting findings bullet points for a visa application revision-request email to the applicant${applicant.name ? ` (${applicant.name})` : ""}.
Below are compliance issues found against Malta's Central Visa Unit Employment Visa checklist. Rewrite each one as a single clear, polite, professional sentence telling the applicant what's wrong and, where the note gives specifics, what's needed to fix it. Do not invent details beyond what's given — no fabricated dates, amounts, or documents. Keep each bullet self-contained and concise (one sentence).

Issues:
${issuesText}

Return ONLY a JSON array of strings, no markdown fences, no commentary, with exactly ${promptIssues.length} entries in the same order as the issues above.`;

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API error ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("") || "";
      if (!rawText) throw new Error("No text in response — the model may have blocked the content or returned nothing.");
      findings = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    }

    if (!Array.isArray(findings) || !findings.length) {
      throw new Error("The engine didn't return any findings text.");
    }

    emailBulletsContainer.innerHTML = "";
    findings.forEach(text => addEmailBullet(String(text)));
    renderEmail();
    setEmailStatus(`Generated ${findings.length} finding${findings.length === 1 ? "" : "s"} with AI. Review before sending.`);
  } catch (err) {
    console.error(err);
    const msg = /Failed to fetch|NetworkError/i.test(err.message || "")
      ? "Can't reach the engine — check it's reachable, or switch engine in Options."
      : (err.message || "Couldn't generate findings.");
    setEmailStatus(msg, true);
  } finally {
    emailGenerateFindingsBtn.disabled = false;
  }
}

emailGenerateFindingsBtn.addEventListener("click", generateFindingsWithAI);

// initial render
renderFileList();
renderRecord(false);
renderLog();
switchView("intake");
