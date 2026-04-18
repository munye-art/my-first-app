(function () {
  if (document.getElementById("yt-factcheck-sidebar")) return;

  let lastAnalyzedVideoId = null;
  let allClaims = [];
  let activeFilter = "ALL";

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
    if (videoId) runAnalysis(videoId);
  });

  async function runAnalysis(videoId) {
    lastAnalyzedVideoId = videoId;
    const resultsDiv = document.getElementById("yt-factcheck-results");
    document.getElementById("yt-fc-filters").style.display = "none";
    document.getElementById("yt-fc-count").textContent = "";

    resultsDiv.innerHTML = `
      <div class="yt-fc-loading">
        <div class="yt-fc-spinner"></div>
        <span>Fetching transcript...</span>
      </div>`;

    try {
      const transcript = await fetchTranscript(videoId);
      if (!transcript) throw new Error("No transcript available for this video.");

      resultsDiv.innerHTML = `
        <div class="yt-fc-loading">
          <div class="yt-fc-spinner"></div>
          <span>Analysing claims...</span>
        </div>`;

      const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
      if (!geminiApiKey) {
        resultsDiv.innerHTML = "<p class='yt-fc-error'>No API key found. Set your Gemini API key in the extension popup.</p>";
        return;
      }

      allClaims = await extractClaims(transcript, geminiApiKey);
      activeFilter = "ALL";
      document.querySelectorAll(".yt-fc-filter").forEach(b => b.classList.remove("yt-fc-filter-active"));
      document.querySelector("[data-filter='ALL']").classList.add("yt-fc-filter-active");
      document.getElementById("yt-fc-count").textContent = `${allClaims.length} claim${allClaims.length !== 1 ? "s" : ""}`;
      document.getElementById("yt-fc-filters").style.display = allClaims.length ? "flex" : "none";
      renderClaims();
    } catch (err) {
      resultsDiv.innerHTML = `<p class='yt-fc-error'>Error: ${err.message}</p>`;
    }
  }

  function renderClaims() {
    const resultsDiv = document.getElementById("yt-factcheck-results");
    const filtered = activeFilter === "ALL" ? allClaims : allClaims.filter(c => c.verdict === activeFilter);
    if (!filtered.length) {
      resultsDiv.innerHTML = "<p class='yt-fc-status'>No claims match this filter.</p>";
      return;
    }
    resultsDiv.innerHTML = filtered.map(c => `
      <div class="yt-fc-claim yt-fc-${c.verdict.replace(/\s+/g, "-").toLowerCase()}">
        <p class="yt-fc-claim-text">${c.claim}</p>
        <span class="yt-fc-verdict">${c.verdict}</span>
        <p class="yt-fc-reason">${c.reason}</p>
      </div>
    `).join("");
  }

  // Auto re-analyze when navigating to a new video (only after first manual trigger)
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const current = window.location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    if (!lastAnalyzedVideoId) return;
    const videoId = new URLSearchParams(window.location.search).get("v");
    if (videoId && videoId !== lastAnalyzedVideoId) {
      sidebar.style.display = "";
      setTimeout(() => runAnalysis(videoId), 1500);
    }
  }).observe(document.body, { childList: true, subtree: true });

})();

// Fetch transcript - tries DOM panel, then YouTube timedtext API
async function fetchTranscript(videoId) {
  const domText = readTranscriptPanel();
  if (domText) return domText;

  const opened = await openTranscriptPanel();
  if (opened) {
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const text = readTranscriptPanel();
      if (text) return text;
    }
  }

  return await fetchTranscriptFromAPI(videoId);
}

function readTranscriptPanel() {
  const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
  for (const panel of panels) {
    const visibility = panel.getAttribute("visibility") || "";
    if (visibility.includes("EXPANDED")) {
      const raw = panel.innerText || panel.textContent || "";
      const lines = raw.split("\n")
        .map(l => l.trim())
        .filter(l => l && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(l) && l.length > 2);
      if (lines.length > 5) return lines.join(" ");
    }
  }

  const selectors = [
    "ytd-transcript-segment-renderer .segment-text",
    "ytd-transcript-segment-renderer yt-formatted-string",
    "ytd-transcript-segment-renderer",
    ".segment-text",
  ];
  for (const sel of selectors) {
    const segs = document.querySelectorAll(sel);
    if (segs.length > 3) {
      const text = Array.from(segs).map(s => s.textContent.trim()).filter(Boolean).join(" ");
      if (text.length > 50) return text;
    }
  }
  return null;
}

async function fetchTranscriptFromAPI(_videoId) {
  try {
    let baseUrl = null;
    for (const script of document.querySelectorAll("script")) {
      const t = script.textContent;
      if (!t.includes("captionTracks")) continue;
      const m = t.match(/"baseUrl":"(https?:\/\/[^"]+timedtext[^"]+)"/);
      if (m) { baseUrl = m[1].replace(/\\u0026/g, "&").replace(/\\/g, ""); break; }
    }
    if (!baseUrl) return null;

    const resp = await fetch(baseUrl + "&fmt=json3", { credentials: "include" });
    if (!resp.ok) return null;

    const data = await resp.json();
    const text = (data.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || "").join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
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

async function extractClaims(transcript, apiKey) {
  const trimmed = transcript.slice(0, 8000);

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
    "reason": "brief explanation"
  }
]

Only return the JSON array, nothing else.

Transcript:
${trimmed}`;

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
  if (!text) throw new Error(`Gemini error: ${JSON.stringify(data?.error || data).slice(0, 200)}`);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse claims from AI response.");

  return JSON.parse(jsonMatch[0]);
}
