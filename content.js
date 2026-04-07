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

// Fetch YouTube transcript using YouTube's internal transcript API
async function fetchTranscript(_videoId) {
  const scripts = document.querySelectorAll("script");

  // Step 1: get InnerTube API key from the page
  let apiKey = null;
  for (const script of scripts) {
    const match = script.textContent.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (match) { apiKey = match[1]; break; }
  }
  console.log("yt-factcheck: apiKey found:", !!apiKey);
  if (!apiKey) return null;

  // Step 2: get transcript params from page
  let params = null;
  for (const script of scripts) {
    const content = script.textContent;
    if (!content.includes("getTranscriptEndpoint")) continue;
    const match = content.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"\}/);
    if (match) { params = match[1]; break; }
  }
  console.log("yt-factcheck: params:", params);

  if (!params) return null;

  // Step 2b: extract client context from page
  let clientContext = { clientName: "WEB", clientVersion: "2.20230619.01.00" };
  for (const script of scripts) {
    const content = script.textContent;
    if (!content.includes("INNERTUBE_CONTEXT")) continue;
    const match = content.match(/"INNERTUBE_CONTEXT"\s*:\s*(\{.+?\})\s*[,;]/s);
    if (match) {
      try {
        const ctx = JSON.parse(match[1]);
        if (ctx.client) { clientContext = ctx.client; break; }
      } catch {}
    }
  }
  console.log("yt-factcheck: client:", JSON.stringify(clientContext).slice(0, 100));

  // Step 3: call YouTube's internal transcript API
  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": "1",
          "X-YouTube-Client-Version": clientContext.clientVersion || "2.20230619.01.00"
        },
        credentials: "include",
        body: JSON.stringify({
          context: { client: clientContext },
          params
        })
      }
    );

    const data = await res.json();
    console.log("yt-factcheck: transcript API response:", JSON.stringify(data).slice(0, 300));

    const segments = data?.actions?.[0]?.updateEngagementPanelAction
      ?.content?.transcriptRenderer?.content
      ?.transcriptSearchPanelRenderer?.body
      ?.transcriptSegmentListRenderer?.initialSegments;

    if (!segments?.length) return null;

    return segments
      .map(s => s?.transcriptSegmentRenderer?.snippet?.runs?.[0]?.text || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch (e) {
    console.error("Transcript API error:", e);
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
