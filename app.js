/* Case Register — document extraction
 * Client-side only. Calls generativelanguage.googleapis.com (Gemini) directly
 * from the browser using a key the user supplies (kept in localStorage, never
 * in this repo).
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

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

const state = {
  files: [],       // {id, file}
  record: null,    // last extracted record (object keyed by FIELDS[].key)
  log: JSON.parse(localStorage.getItem("case_log") || "[]"),
};

const el = (id) => document.getElementById(id);
const fileListEl = el("fileList");
const fileCountEl = el("fileCount");
const extractBtn = el("extractBtn");
const statusEl = el("status");
const recordBody = el("recordBody");
const recordTag = el("recordTag");
const logBody = el("logBody");
const logCount = el("logCount");

// ---------- API key persistence ----------
const apiKeyInput = el("apiKey");
apiKeyInput.value = localStorage.getItem("case_register_gemini_key") || "";
apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("case_register_gemini_key", apiKeyInput.value.trim());
});

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
- uncertain: separate from comments. List each field you were NOT confident about and why — e.g. handwriting was hard to read, two documents gave conflicting dates, a value was inferred rather than directly stated. Leave this empty ("") only if you're confident in every field you filled in.`;

    const body = {
      contents: [{ role: "user", parts: [{ text: instruction }, ...parts] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    const model = "gemini-3.6-flash";
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
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

// ---------- Draft record UI ----------
function renderRecord(justExtracted) {
  if (state.record) {
    recordTag.textContent = (state.record.uncertain || "").trim() ? "Draft — check uncertainty notes" : "Draft — review";
  } else {
    recordTag.textContent = "Unverified";
  }
  if (!state.record) {
    recordBody.innerHTML = `<div class="empty-state"><span class="mark">§</span>Extracted fields will appear here for review once documents are processed.</div>`;
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
  saveBtn.textContent = "Save to case log";
  saveBtn.onclick = saveToLog;
  const discardBtn = document.createElement("button");
  discardBtn.className = "btn secondary";
  discardBtn.textContent = "Discard draft";
  discardBtn.onclick = () => { state.record = null; renderRecord(false); };
  actions.appendChild(saveBtn);
  actions.appendChild(discardBtn);
  wrap.appendChild(actions);

  recordBody.innerHTML = "";
  recordBody.appendChild(wrap);
}

function saveToLog() {
  state.log.push({ ...state.record, savedAt: new Date().toISOString() });
  localStorage.setItem("case_log", JSON.stringify(state.log));
  state.record = null;
  state.files = [];
  renderFileList();
  renderRecord(false);
  renderLog();
  setStatus("Saved to case log.");
}

// ---------- Case log ----------
function renderLog() {
  logCount.textContent = `${state.log.length} case${state.log.length === 1 ? "" : "s"}`;
  if (state.log.length === 0) {
    logBody.innerHTML = `<tr><td colspan="11" style="color:var(--muted); text-align:center;">No cases logged yet.</td></tr>`;
    return;
  }
  logBody.innerHTML = "";
  state.log.forEach((rec, idx) => {
    const tr = document.createElement("tr");
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
      <td><button class="row-del" data-idx="${idx}">remove</button></td>
    `;
    logBody.appendChild(tr);
  });
  logBody.querySelectorAll(".row-del").forEach(btn => {
    btn.addEventListener("click", () => {
      state.log.splice(Number(btn.dataset.idx), 1);
      localStorage.setItem("case_log", JSON.stringify(state.log));
      renderLog();
    });
  });
}

el("exportBtn").addEventListener("click", () => {
  if (state.log.length === 0) { setStatus("No cases to export yet.", true); return; }
  const keys = FIELDS.map(f => f.key);
  const header = keys.join(",");
  const rows = state.log.map(rec =>
    keys.map(k => csvCell(rec[k] || "")).join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `case-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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

// initial render
renderFileList();
renderRecord(false);
renderLog();
