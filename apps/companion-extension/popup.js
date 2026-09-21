const site = document.querySelector("#site");
const button = document.querySelector("#connect");
const status = document.querySelector("#status");
let origin = null;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
try {
  origin = new URL(tab?.url ?? "").origin;
  site.textContent = origin;
} catch {
  site.textContent = "Open the ScreenMesh site first.";
  button.disabled = true;
}

button.addEventListener("click", async () => {
  if (!origin) return;
  button.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "screenmesh.configureTrustedSite", origin });
  status.textContent = response.ok ? "Connected. Reload the ScreenMesh tab." : response.error;
  if (!response.ok) button.disabled = false;
});
