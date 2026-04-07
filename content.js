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
  return new Promise((resolve) => {
    // Inject a script into the page context to access ytInitialPlayerResponse
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
            if (track?.baseUrl) {
              window.dispatchEvent(new CustomEvent("yt-fc-track", { detail: track.baseUrl }));
              return;
            }
          }
          window.dispatchEvent(new CustomEvent("yt-fc-track", { detail: null }));
        } catch(e) {
          window.dispatchEvent(new CustomEvent("yt-fc-track", { detail: null }));
        }
      })();
    `;

    window.addEventListener("yt-fc-track", async (e) => {
      const baseUrl = e.detail;
      if (!baseUrl) { resolve(null); return; }

      try {
        const res = await fetch(baseUrl + "&fmt=json3");
        const data = await res.json();

        if (data?.events) {
          const text = data.events
            .filter(e => e.segs)
            .map(e => e.segs.map(s => s.utf8).join(""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          resolve(text || null);
          return;
        }

        // Fallback: XML format
        const xmlRes = await fetch(baseUrl);
        const xmlText = await xmlRes.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(xmlText, "text/xml");
        const texts = Array.from(xml.querySelectorAll("text"));
        resolve(texts.map(t => t.textContent).join(" ").replace(/\s+/g, " ").trim() || null);
      } catch {
        resolve(null);
      }
    }, { once: true });

    document.documentElement.appendChild(script);
    script.remove();
  });
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
