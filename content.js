let transcriptEvents = null; // [{tStartMs, text}] — shared with getTranscriptChunk outside IIFE

(function () {
  if (document.getElementById("yt-factcheck-sidebar")) return;

  let lastAnalyzedVideoId = null;
  let allClaims = [];
  let activeFilter = "ALL";
  let analyzedUpToMs = 0;
  let analysisInterval = null;
  let currentApiKey = null;
  let isAnalyzing = false;

  const CHUNK_MS = 4 * 60 * 1000; // analyze 4 minutes at a time
  const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds

  const sidebar = document.createElement("div");
  sidebar.id = "yt-factcheck-sidebar";
  sidebar.innerHTML = `
    <div id="yt-factcheck-header">
      <div id="yt-fc-title-area">
        <span>🔍 Fact Checker</span>
        <span id="yt-fc-count"></span>
      </div>
      <div id="yt-fc-header-btns">
        <button id="yt-factcheck-minimize" title="Minimize">−</button>
        <button id="yt-factcheck-close" title="Close">✕</button>
      </div>
    </div>
    <div id="yt-factcheck-body">
      <button id="yt-factcheck-btn">Check This Video</button>
      <div id="yt-fc-filters">
        <button class="yt-fc-filter yt-fc-filter-active" data-filter="ALL">All</button>
        <button class="yt-fc-filter" data-filter="LIKELY TRUE">✓ True</button>
        <button class="yt-fc-filter" data-filter="LIKELY FALSE">✗ False</button>
        <button class="yt-fc-filter" data-filter="UNVERIFIED">? Unverified</button>
      </div>
      <div id="yt-factcheck-results"></div>
    </div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById("yt-factcheck-minimize").addEventListener("click", () => {
    const body = document.getElementById("yt-factcheck-body");
    const btn = document.getElementById("yt-factcheck-minimize");
    const isHidden = body.style.display === "none";
    body.style.display = isHidden ? "" : "none";
    btn.textContent = isHidden ? "−" : "+";
  });

  document.getElementById("yt-factcheck-close").addEventListener("click", () => {
    sidebar.style.display = "none";
  });

  document.getElementById("yt-fc-filters").addEventListener("click", e => {
    const btn = e.target.closest(".yt-fc-filter");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".yt-fc-filter").forEach(b => b.classList.remove("yt-fc-filter-active"));
    btn.classList.add("yt-fc-filter-active");
    renderClaims();
  });

  document.getElementById("yt-factcheck-btn").addEventListener("click", () => {
    const videoId = new URLSearchParams(window.location.search).get("v");
    if (videoId) startAnalysis(videoId);
  });

  async function startAnalysis(videoId) {
    clearInterval(analysisInterval);
    isAnalyzing = false;
    lastAnalyzedVideoId = videoId;
    allClaims = [];
    transcriptEvents = null;
    analyzedUpToMs = 0;
    activeFilter = "ALL";

    document.querySelectorAll(".yt-fc-filter").forEach(b => b.classList.remove("yt-fc-filter-active"));
    document.querySelector("[data-filter='ALL']").classList.add("yt-fc-filter-active");
    document.getElementById("yt-fc-filters").style.display = "none";
    document.getElementById("yt-fc-count").textContent = "";

    // Capture position BEFORE any async calls so we get the true current time
    const currentMs = getVideoMs();
    analyzedUpToMs = Math.max(0, currentMs - 5000);
    setStatus(`Fetching transcript… (position: ${formatTime(currentMs)})`);

    const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
    if (!geminiApiKey) {
      setError("No API key found. Set your Gemini API key in the extension popup.");
      return;
    }
    currentApiKey = geminiApiKey;

    // Try timed transcript first (preferred)
    transcriptEvents = await fetchTranscriptEvents();

    if (!transcriptEvents) {
      // Open transcript panel if needed for DOM fallback
      if (!readTranscriptPanel(analyzedUpToMs)) await openAndReadPanel(analyzedUpToMs);
    }

    // Analyze first chunk then keep going as video plays (both paths)
    if (transcriptEvents) {
      await analyzeChunk(analyzedUpToMs + CHUNK_MS);
    } else {
      await analyzeChunkFromDOM();
    }
    analysisInterval = setInterval(checkProgress, CHECK_INTERVAL_MS);
  }

  async function checkProgress() {
    if (isAnalyzing || !currentApiKey) return;
    const currentMs = getVideoMs();
    if (currentMs < analyzedUpToMs) return;
    if (transcriptEvents) {
      await analyzeChunk(currentMs);
    } else {
      await analyzeChunkFromDOM();
    }
  }

  async function analyzeChunkFromDOM() {
    if (isAnalyzing) return;
    isAnalyzing = true;
    const fromMs = analyzedUpToMs;
    const toMs = fromMs + CHUNK_MS;
    const text = readTranscriptPanel(fromMs);
    if (!text) { analyzedUpToMs = toMs; isAnalyzing = false; return; }
    const fromMin = Math.round(fromMs / 60000);
    const toMin = Math.round(toMs / 60000);
    setStatus(`Analysing ${fromMin}–${toMin} min...`, true);
    try {
      const claims = await extractClaimsWithRetry(text.slice(0, 4000), currentApiKey);
      analyzedUpToMs = toMs;
      addClaims(claims, fromMs);
    } catch (e) { setError(e.message); }
    isAnalyzing = false;
  }

  async function analyzeChunk(toMs) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    const fromMs = analyzedUpToMs;
    const chunk = getTranscriptChunk(fromMs, toMs);
    if (!chunk) { analyzedUpToMs = toMs; isAnalyzing = false; return; }

    const fromMin = Math.round(fromMs / 60000);
    const toMin = Math.round(toMs / 60000);
    setStatus(`Analysing ${fromMin}–${toMin} min...`, true);

    try {
      const claims = await extractClaimsWithRetry(chunk, currentApiKey);
      analyzedUpToMs = toMs;
      addClaims(claims, fromMs);
    } catch (e) {
      setError(e.message);
    } finally {
      isAnalyzing = false;
    }
  }

  function addClaims(newClaims, fromMs = 0) {
    if (!newClaims.length) { renderClaims(); return; }
    allClaims.push(...newClaims.map(c => ({ ...c, timestampMs: parseTimestamp(c.timestamp) || fromMs })));
    document.getElementById("yt-fc-count").textContent = `${allClaims.length} claim${allClaims.length !== 1 ? "s" : ""}`;
    document.getElementById("yt-fc-filters").style.display = "flex";
    renderClaims();
  }

  function renderClaims() {
    const resultsDiv = document.getElementById("yt-factcheck-results");
    const filtered = activeFilter === "ALL" ? allClaims : allClaims.filter(c => c.verdict === activeFilter);
    if (!filtered.length) {
      resultsDiv.innerHTML = allClaims.length
        ? "<p class='yt-fc-status'>No claims match this filter.</p>"
        : "<p class='yt-fc-status'>No factual claims detected yet.</p>";
      return;
    }
    resultsDiv.innerHTML = filtered.map(c => `
      <div class="yt-fc-claim yt-fc-${c.verdict.replace(/\s+/g, "-").toLowerCase()}">
        <div class="yt-fc-claim-header">
          <span class="yt-fc-verdict">${c.verdict}</span>
          <button class="yt-fc-timestamp" data-ms="${c.timestampMs || 0}">▶ ${formatTime(c.timestampMs || 0)}</button>
        </div>
        <p class="yt-fc-claim-text">${c.claim}</p>
        <p class="yt-fc-reason">${c.reason}</p>
      </div>
    `).join("");
  }

  function setStatus(msg, keepClaims = false) {
    const resultsDiv = document.getElementById("yt-factcheck-results");
    const spinner = `<div class="yt-fc-loading"><div class="yt-fc-spinner"></div><span>${msg}</span></div>`;
    resultsDiv.innerHTML = keepClaims && allClaims.length
      ? spinner + resultsDiv.innerHTML
      : spinner;
  }

  function setError(msg) {
    document.getElementById("yt-factcheck-results").innerHTML = `<p class='yt-fc-error'>Error: ${msg}</p>`;
  }

  document.getElementById("yt-factcheck-results").addEventListener("click", e => {
    const btn = e.target.closest(".yt-fc-timestamp");
    if (!btn) return;
    const video = document.querySelector("video");
    if (video) video.currentTime = parseInt(btn.dataset.ms) / 1000;
  });

  // Watch for YouTube SPA navigation (only auto re-analyze after first manual trigger)
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const current = window.location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    if (!lastAnalyzedVideoId) return;
    const videoId = new URLSearchParams(window.location.search).get("v");
    if (videoId && videoId !== lastAnalyzedVideoId) {
      clearInterval(analysisInterval);
      sidebar.style.display = "";
      setTimeout(() => startAnalysis(videoId), 1500);
    }
  }).observe(document.body, { childList: true, subtree: true });

})();

// --- Transcript helpers ---

async function fetchTranscriptEvents() {
  let baseUrl = null;

  // Method 1: find caption URL in page script tags (works on direct/fresh page load)
  for (const script of document.querySelectorAll("script")) {
    const t = script.textContent;
    if (!t.includes("captionTracks")) continue;
    const m = t.match(/"baseUrl":"(https?:\/\/[^"]+timedtext[^"]+)"/);
    if (m) { baseUrl = m[1].replace(/\\u0026/g, "&").replace(/\\/g, ""); break; }
  }

  // Method 2: try direct timedtext API with video ID (auto-generated English captions)
  if (!baseUrl) {
    const videoId = new URLSearchParams(window.location.search).get("v");
    if (videoId) baseUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr`;
  }

  if (!baseUrl) return null;

  try {
    const resp = await fetch(baseUrl + "&fmt=json3", { credentials: "include" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const events = (data.events || [])
      .filter(e => e.segs && e.tStartMs !== undefined)
      .map(e => ({ tStartMs: e.tStartMs, text: e.segs.map(s => s.utf8 || "").join("").trim() }))
      .filter(e => e.text);
    return events.length ? events : null;
  } catch {
    return null;
  }
}


function getVideoMs() {
  // Most reliable: video element currentTime
  let best = 0;
  document.querySelectorAll("video").forEach(v => { if (v.currentTime > best) best = v.currentTime; });
  if (best > 0) return best * 1000;

  // Fallback: YouTube player API
  const player = document.querySelector("#movie_player");
  if (player && typeof player.getCurrentTime === "function") {
    const t = player.getCurrentTime();
    if (t > 0) return t * 1000;
  }

  // Fallback: time display text (unreliable on live streams — use only if above failed)
  const timeEl = document.querySelector(".ytp-time-current");
  if (timeEl && timeEl.textContent) {
    const ms = parseTimestamp(timeEl.textContent.trim());
    // Sanity check: ignore if it looks like a wall-clock time > video duration
    const durEl = document.querySelector(".ytp-time-duration");
    const durMs = durEl ? parseTimestamp(durEl.textContent.trim()) : Infinity;
    if (ms > 0 && ms <= durMs) return ms;
  }

  return 0;
}

function parseTimestamp(ts) {
  if (!ts) return 0;
  const parts = String(ts).split(":").map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return 0;
}

function getTranscriptChunk(fromMs, toMs) {
  if (!transcriptEvents) return null;
  const lines = transcriptEvents
    .filter(e => e.tStartMs >= fromMs && e.tStartMs < toMs)
    .map(e => `[${formatTime(e.tStartMs)}] ${e.text}`);
  const text = lines.join("\n").trim();
  return text.length > 50 ? text : null;
}

function readTranscriptPanel(fromMs = 0) {
  // Position-aware: parse timestamp directly from each segment's text content
  // Try segment renderers first — position-aware via timestamp regex
  const segs = document.querySelectorAll("ytd-transcript-segment-renderer");
  if (segs.length > 3) {
    const lines = [];
    let lastKnownMs = 0;
    for (const seg of segs) {
      const raw = seg.textContent || "";
      const tsMatch = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (tsMatch) lastKnownMs = parseTimestamp(tsMatch[1]);
      if (lastKnownMs > 0 && lastKnownMs < fromMs) continue;
      const text = raw.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, "")
        .split("\n").map(l => l.trim()).filter(l => l && l.length > 2).join(" ");
      if (text) lines.push(text);
      if (lines.join(" ").length >= 4000) break;
    }
    if (lines.length > 5) return lines.join(" ").slice(0, 4000);
  }

  // Fallback: expanded panel innerText — position-aware by parsing timestamp lines
  const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
  for (const panel of panels) {
    const visibility = panel.getAttribute("visibility") || "";
    if (!visibility.includes("EXPANDED")) continue;
    const raw = panel.innerText || panel.textContent || "";
    const parts = raw.split("\n");
    let collecting = fromMs <= 0;
    const lines = [];
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) {
        if (!collecting && parseTimestamp(t) >= fromMs) collecting = true;
        continue;
      }
      if (collecting && t.length > 2) {
        lines.push(t);
        if (lines.join(" ").length >= 4000) break;
      }
    }
    if (lines.length > 5) return lines.join(" ").slice(0, 4000);
  }
  return null;
}

async function openAndReadPanel(fromMs = 0) {
  const opened = await openTranscriptPanel();
  if (!opened) return null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const text = readTranscriptPanel(fromMs);
    if (text) return text;
  }
  return null;
}

async function openTranscriptPanel() {
  const allButtons = document.querySelectorAll("button, [role='button'], tp-yt-paper-button");
  for (const btn of allButtons) {
    const label = (btn.textContent || btn.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("transcript")) { btn.click(); return true; }
  }
  const moreBtn =
    document.querySelector("#above-the-fold #button-shape button") ||
    document.querySelector("ytd-menu-renderer yt-button-shape button") ||
    document.querySelector("#info-contents ytd-menu-renderer button");
  if (moreBtn) {
    moreBtn.click();
    await sleep(600);
    const items = document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer");
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes("transcript")) { item.click(); return true; }
    }
    document.body.click();
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- Gemini ---

async function extractClaimsWithRetry(text, apiKey, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await extractClaims(text, apiKey);
    } catch (e) {
      if (i < retries && (e.message.includes("503") || e.message.includes("UNAVAILABLE"))) {
        await sleep(4000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

async function extractClaims(transcript, apiKey) {
  const prompt = `You are a fact-checking assistant. Read the following transcript from a YouTube video.

Your job is to:
1. Identify ONLY statements presented as facts (not opinions, not "I think", not "I believe")
2. For each factual claim, assess whether it is: LIKELY TRUE, LIKELY FALSE, or UNVERIFIED
3. Give a one-line reason for your assessment

Return your response as a JSON array in this exact format:
[
  {
    "claim": "the factual claim here",
    "verdict": "LIKELY TRUE" | "LIKELY FALSE" | "UNVERIFIED",
    "reason": "brief explanation",
    "timestamp": "MM:SS"
  }
]

Use the [MM:SS] markers in the transcript to set the timestamp to when the claim was made.
Only return the JSON array, nothing else.

Transcript:
${transcript}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(JSON.stringify(data?.error || data).slice(0, 200));

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse claims from AI response.");

  return JSON.parse(jsonMatch[0]);
}
