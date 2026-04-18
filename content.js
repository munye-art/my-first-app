// Inject sidebar when on a YouTube video page
(function () {
  if (document.getElementById("yt-factcheck-sidebar")) return;

  // Create sidebar
  const sidebar = document.createElement("div");
  sidebar.id = "yt-factcheck-sidebar";
  sidebar.innerHTML = `
    <div id="yt-factcheck-header">
      <span>🔍 Fact Checker</span>
      <button id="yt-factcheck-close">✕</button>
    </div>
    <div id="yt-factcheck-body">
      <button id="yt-factcheck-btn">Check This Video</button>
      <div id="yt-factcheck-results"></div>
    </div>
  `;
  document.body.appendChild(sidebar);

  // Close sidebar
  document.getElementById("yt-factcheck-close").addEventListener("click", () => {
    sidebar.style.display = "none";
  });

  // Main button click
  document.getElementById("yt-factcheck-btn").addEventListener("click", async () => {
    const resultsDiv = document.getElementById("yt-factcheck-results");
    resultsDiv.innerHTML = "<p class='yt-fc-status'>Fetching transcript...</p>";

    try {
      const videoId = new URLSearchParams(window.location.search).get("v");
      if (!videoId) throw new Error("Could not find video ID.");

      // Fetch transcript
      const transcript = await fetchTranscript(videoId);
      if (!transcript) throw new Error("No transcript available for this video.");

      resultsDiv.innerHTML = "<p class='yt-fc-status'>Analysing claims with AI...</p>";

      // Get API key from storage
      const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
      if (!geminiApiKey) {
        resultsDiv.innerHTML = "<p class='yt-fc-error'>No API key found. Please set your Gemini API key in the extension popup.</p>";
        return;
      }

      // Send to Gemini
      const claims = await extractClaims(transcript, geminiApiKey);
      displayResults(claims, resultsDiv);

    } catch (err) {
      resultsDiv.innerHTML = `<p class='yt-fc-error'>Error: ${err.message}</p>`;
    }
  });
})();

// Fetch transcript - tries DOM, then YouTube timedtext API
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

  // Fall back to YouTube timedtext API
  return await fetchTranscriptFromAPI(videoId);
}

function readTranscriptPanel() {
  // Try engagement panel innerText (works even if children are in shadow DOM)
  const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
  for (const panel of panels) {
    const visibility = panel.getAttribute('visibility') || '';
    if (visibility.includes('EXPANDED')) {
      const raw = panel.innerText || panel.textContent || '';
      const lines = raw.split('\n')
        .map(l => l.trim())
        .filter(l => l && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(l) && l.length > 2);
      if (lines.length > 5) return lines.join(' ');
    }
  }

  // Try direct selectors as fallback
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
    for (const script of document.querySelectorAll('script')) {
      const t = script.textContent;
      if (!t.includes('captionTracks')) continue;
      const m = t.match(/"baseUrl":"(https?:\/\/[^"]+timedtext[^"]+)"/);
      if (m) { baseUrl = m[1].replace(/\\u0026/g, '&').replace(/\\/g, ''); break; }
    }
    console.log('yt-factcheck: timedtext baseUrl:', baseUrl ? baseUrl.slice(0, 80) : 'not found');
    if (!baseUrl) return null;

    const resp = await fetch(baseUrl + '&fmt=json3', { credentials: 'include' });
    if (!resp.ok) { console.log('yt-factcheck: timedtext status:', resp.status); return null; }

    const data = await resp.json();
    const text = (data.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 50 ? text : null;
  } catch (e) {
    console.log('yt-factcheck: API fetch error:', e.message);
    return null;
  }
}

async function openTranscriptPanel() {
  // Method 1: look for a visible "Show transcript" button anywhere
  const allButtons = document.querySelectorAll("button, [role='button'], tp-yt-paper-button");
  for (const btn of allButtons) {
    const label = (btn.textContent || btn.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("transcript")) {
      btn.click();
      return true;
    }
  }

  // Method 2: open the "..." more actions menu and find transcript option
  const moreBtn =
    document.querySelector("#above-the-fold #button-shape button") ||
    document.querySelector("ytd-menu-renderer yt-button-shape button") ||
    document.querySelector("#info-contents ytd-menu-renderer button");

  if (moreBtn) {
    moreBtn.click();
    await sleep(600);

    const items = document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer");
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes("transcript")) {
        item.click();
        return true;
      }
    }

    // Close menu if transcript not found
    document.body.click();
  }

  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Send transcript to Gemini and extract factual claims
async function extractClaims(transcript, apiKey) {
  const trimmed = transcript.slice(0, 8000); // limit to avoid token overload

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
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  const data = await response.json();
  console.log("yt-factcheck: Gemini status:", response.status);
  console.log("yt-factcheck: Gemini response:", JSON.stringify(data).slice(0, 400));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini error: ${JSON.stringify(data?.error || data).slice(0, 200)}`);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse claims from AI response.");

  return JSON.parse(jsonMatch[0]);
}

// Display results in the sidebar
function displayResults(claims, container) {
  if (!claims.length) {
    container.innerHTML = "<p class='yt-fc-status'>No clear factual claims detected.</p>";
    return;
  }

  container.innerHTML = claims.map(c => `
    <div class="yt-fc-claim yt-fc-${c.verdict.replace(/\s+/g, "-").toLowerCase()}">
      <p class="yt-fc-claim-text">${c.claim}</p>
      <span class="yt-fc-verdict">${c.verdict}</span>
      <p class="yt-fc-reason">${c.reason}</p>
    </div>
  `).join("");
}
