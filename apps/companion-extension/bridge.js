// This script is registered only after the user explicitly selects an exact
// ScreenMesh site in the extension popup. It is intentionally a narrow bridge:
// no arbitrary native commands, only the typed companion route/session bridge.
window.addEventListener("screenmesh-companion-request", (event) => {
  const requestId = event.detail?.requestId;
  const request = event.detail?.request;
  if (typeof requestId !== "string" || !request || typeof request.type !== "string") return;
  chrome.runtime.sendMessage({ type: "screenmesh.companionRequest", request }, (response) => {
    window.dispatchEvent(new CustomEvent("screenmesh-companion-response", {
      detail: { requestId, response: response ?? { ok: false, error: "Companion did not respond." } }
    }));
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "screenmesh.companionEvent" || !String(message.event?.type).startsWith("screenmesh.lan.")) return;
  window.dispatchEvent(new CustomEvent("screenmesh-companion-event", { detail: message.event }));
});
