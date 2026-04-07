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

// Fetch YouTube transcript by reading ytInitialPlayerResponse from the page
async function fetchTranscript(videoId) {
  // Step 1: inject a script into the page context to read ytInitialPlayerResponse
  const baseUrl = await new Promise((resolve) => {
    window.addEventListener("message", function handler(e) {
      if (e.source !== window || e.data?.type !== "yt-fc-track-url") return;
      window.removeEventListener("message", handler);
      resolve(e.data.url || null);
    });

    const script = document.createElement("script");
    script.textContent = `
      (function() {
        try {
          const data = window.ytInitialPlayerResponse;
          const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (tracks && tracks.length) {
            const track = tracks.find(t => t.languageCode === "en")
              || tracks.find(t => t.languageCode?.startsWith("en"))
              || tracks[0];
            window.postMessage({ type: "yt-fc-track-url", url: track?.baseUrl || null }, "*");
          } else {
            window.postMessage({ type: "yt-fc-track-url", url: null }, "*");
          }
        } catch(e) {
          window.postMessage({ type: "yt-fc-track-url", url: null }, "*");
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  });

  if (!baseUrl) return null;

  // Step 2: fetch the transcript from the URL
  try {
    const res = await fetch(baseUrl);
    const rawText = await res.text();

    // Try XML parsing (most reliable)
    const parser = new DOMParser();
    const xml = parser.parseFromString(rawText, "text/xml");
    const texts = Array.from(xml.querySelectorAll("text"));
    if (texts.length) {
      return texts
        .map(t => t.textContent
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Fallback: JSON3 format
    try {
      const data = JSON.parse(rawText);
      if (data?.events) {
        return data.events
          .filter(e => e.segs)
          .map(e => e.segs.map(s => s.utf8).join(""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    } catch {}

    return null;
  } catch (e) {
    console.error("Transcript fetch error:", e);
    return null;
  }
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No response from Gemini.");

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
