// This script is registered only after the user explicitly selects an exact
// ScreenMesh site in the extension popup. It is intentionally a narrow bridge:
// no arbitrary native commands, just the read-only interface-list request.
window.addEventListener("screenmesh-companion-request", (event) => {
  const requestId = event.detail?.requestId;
  if (typeof requestId !== "string") return;
  chrome.runtime.sendMessage({ type: "screenmesh.listNetworkInterfaces" }, (response) => {
    window.dispatchEvent(new CustomEvent("screenmesh-companion-response", {
      detail: { requestId, response: response ?? { ok: false, error: "Companion did not respond." } }
    }));
  });
});
