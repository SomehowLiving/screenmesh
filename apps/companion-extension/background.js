const HOST_NAME = "com.screenmesh.companion";
const SCRIPT_ID = "screenmesh-companion-bridge";
const ALLOWED_COMPANION_REQUESTS = new Set([
  "screenmesh.listNetworkInterfaces",
  "screenmesh.startLanSession",
  "screenmesh.stopLanSession",
  "screenmesh.getLanSession",
  "screenmesh.sendLanEnvelope",
]);
let nativePort = null;
let activeNativeRequest = null;
const queuedNativeRequests = [];

function siteMatch(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

async function trustedOrigin() {
  const { trustedOrigin: origin } = await chrome.storage.local.get("trustedOrigin");
  return typeof origin === "string" ? origin : null;
}

async function broadcastLanEnvelope(event) {
  const origin = await trustedOrigin();
  if (!origin) return;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    if (typeof tab.id === "number") {
      chrome.tabs.sendMessage(tab.id, { type: "screenmesh.companionEvent", event }).catch(() => {});
    }
  }
}

/**
 * `sendNativeMessage` tears down the native host after one reply. LAN
 * listeners need a persistent host, so requests are serialized over a
 * single `connectNative` port. The port never exposes an arbitrary command.
 */
function pumpNativeRequests() {
  if (activeNativeRequest || queuedNativeRequests.length === 0) return;
  if (!nativePort) {
    try {
      nativePort = chrome.runtime.connectNative(HOST_NAME);
      nativePort.onMessage.addListener((response) => {
        if (response?.type === "screenmesh.lan.envelope" || response?.type === "screenmesh.lan.connected") {
          void broadcastLanEnvelope(response);
          return;
        }
        const request = activeNativeRequest;
        activeNativeRequest = null;
        request?.resolve(response ?? { ok: false, error: "Companion did not respond." });
        pumpNativeRequests();
      });
      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message ?? "ScreenMesh Companion disconnected.";
        nativePort = null;
        activeNativeRequest?.resolve({ ok: false, error });
        activeNativeRequest = null;
        while (queuedNativeRequests.length > 0) queuedNativeRequests.shift()?.resolve({ ok: false, error });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ScreenMesh Companion is unavailable.";
      while (queuedNativeRequests.length > 0) queuedNativeRequests.shift()?.resolve({ ok: false, error: message });
      return;
    }
  }
  activeNativeRequest = queuedNativeRequests.shift();
  nativePort.postMessage(activeNativeRequest.message);
}

function requestNative(message) {
  return new Promise((resolve) => {
    queuedNativeRequests.push({ message, resolve });
    pumpNativeRequests();
  });
}

async function installBridge(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ["bridge.js"],
      matches: [siteMatch(origin)],
      runAt: "document_start",
      persistAcrossSessions: true
    }
  ]);
}

async function setTrustedSite(origin) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("The companion can only be connected to an HTTPS site or localhost.");
  }
  const match = siteMatch(url.origin);
  const granted = await chrome.permissions.request({ origins: [match] });
  if (!granted) throw new Error("Site access was not granted.");
  await chrome.storage.local.set({ trustedOrigin: url.origin });
  await installBridge(url.origin);
  return url.origin;
}

chrome.runtime.onStartup.addListener(async () => {
  const origin = await trustedOrigin();
  if (origin) await installBridge(origin).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "screenmesh.configureTrustedSite") {
    void setTrustedSite(message.origin).then(
      (origin) => sendResponse({ ok: true, origin }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message?.type !== "screenmesh.companionRequest" || !ALLOWED_COMPANION_REQUESTS.has(message.request?.type)) return undefined;
  void trustedOrigin().then(async (origin) => {
    if (!origin || sender.origin !== origin) {
      sendResponse({ ok: false, error: "This page is not approved to use the ScreenMesh Companion." });
      return;
    }
    try {
      sendResponse(await requestNative(message.request));
    } catch {
      sendResponse({ ok: false, error: "ScreenMesh Companion is not installed or is not running." });
    }
  });
  return true;
});
