// Load saved key on open
chrome.storage.sync.get("geminiApiKey", ({ geminiApiKey }) => {
  if (geminiApiKey) {
    document.getElementById("apiKey").value = geminiApiKey;
    document.getElementById("status").textContent = "API key saved.";
  }
});

// Save key on button click
document.getElementById("saveBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKey").value.trim();
  if (!key) {
    document.getElementById("status").textContent = "Please enter a key.";
    return;
  }
  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    document.getElementById("status").textContent = "Key saved successfully!";
  });
});
