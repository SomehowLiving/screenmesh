const HOST_NAME = "com.screenmesh.companion";
const SCRIPT_ID = "screenmesh-companion-bridge";

function siteMatch(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

async function trustedOrigin() {
  const { trustedOrigin: origin } = await chrome.storage.local.get("trustedOrigin");
  return typeof origin === "string" ? origin : null;
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

  if (message?.type !== "screenmesh.listNetworkInterfaces") return undefined;
  void trustedOrigin().then(async (origin) => {
    if (!origin || sender.origin !== origin) {
      sendResponse({ ok: false, error: "This page is not approved to use the ScreenMesh Companion." });
      return;
    }
    try {
      sendResponse(await chrome.runtime.sendNativeMessage(HOST_NAME, { type: "screenmesh.listNetworkInterfaces" }));
    } catch {
      sendResponse({ ok: false, error: "ScreenMesh Companion is not installed or is not running." });
    }
  });
  return true;
});
