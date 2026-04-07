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

// Fetch transcript by opening YouTube's transcript panel and reading the DOM
async function fetchTranscript(_videoId) {
  // If transcript panel is already open, read it directly
  const existing = readTranscriptPanel();
  if (existing) return existing;

  // Try to open the transcript panel via YouTube's UI
  const opened = await openTranscriptPanel();
  if (!opened) return null;

  // Wait up to 5 seconds for segments to appear
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const text = readTranscriptPanel();
    if (text) return text;
  }

  return null;
}

function readTranscriptPanel() {
  const segs = document.querySelectorAll("ytd-transcript-segment-renderer .segment-text");
  if (!segs.length) return null;
  return Array.from(segs).map(s => s.textContent.trim()).filter(Boolean).join(" ");
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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
