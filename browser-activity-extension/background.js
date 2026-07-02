const FIREBASE_API_KEY = "AIzaSyCePI7vcwLfQQLms3MB-LZ2VO8ezrDllMU";
const FIREBASE_PROJECT_ID = "patricks-chrome";

const AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";
const TOKEN_BASE = "https://securetoken.googleapis.com/v1/token";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const BLOCK_RULE_ID = 101;
const FIVE_AM_SHIFT_MS = 5 * 60 * 60 * 1000;
const IDLE_SECONDS = 90;
const MIN_SEGMENT_MS = 5000;

let state = {
  active: false,
  currentTabId: null,
  currentWindowId: null,
  currentUrl: null,
  currentHost: null,
  currentTitle: null,
  currentStartedAtMs: null,
  currentSessionId: null,
  currentSessionStartedAtMs: null,
  browser: detectBrowser()
};

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function init() {
  chrome.idle.setDetectionInterval(IDLE_SECONDS);

  await chrome.alarms.clearAll();

  chrome.alarms.create("activityTick", {
    periodInMinutes: 0.5
  });

  await ensureDefaultSettings();
  await restoreState();
  await pullRemoteSettingsAndApplyRules();
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "activityTick") return;

  await heartbeat();
  await pullRemoteSettingsAndApplyRules();
});

chrome.tabs.onActivated.addListener(async activeInfo => {
  await handlePossibleActivityChange(activeInfo.tabId, activeInfo.windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    const activeTabInfo = await getActiveTabInfo();

    if (activeTabInfo && activeTabInfo.tabId === tabId) {
      await handlePossibleActivityChange(tabId, activeTabInfo.windowId);
    }
  }
});

chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopCurrentActivity("window_unfocused");
    return;
  }

  const activeTabInfo = await getActiveTabInfo(windowId);

  if (activeTabInfo) {
    await handlePossibleActivityChange(activeTabInfo.tabId, windowId);
  }
});

chrome.idle.onStateChanged.addListener(async newState => {
  if (newState === "idle" || newState === "locked") {
    await stopCurrentActivity(`idle_${newState}`);
    return;
  }

  if (newState === "active") {
    const activeTabInfo = await getActiveTabInfo();

    if (activeTabInfo) {
      await handlePossibleActivityChange(activeTabInfo.tabId, activeTabInfo.windowId);
    }
  }
});

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;

  const activeTabInfo = await getActiveTabInfo();

  if (activeTabInfo && activeTabInfo.tabId === details.tabId) {
    await handlePossibleActivityChange(details.tabId, activeTabInfo.windowId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch(error => {
      sendResponse({
        ok: false,
        error: error.message || String(error)
      });
    });

  return true;
});

async function handleRuntimeMessage(message) {
  if (!message || !message.type) {
    return {
      ok: false,
      error: "Missing message type."
    };
  }

  if (message.type === "SIGN_IN") {
    const auth = await signInWithEmailPassword(message.email, message.password);
    await saveAuth(auth);
    await ensureUserSettingsInFirestore();
    await pullRemoteSettingsAndApplyRules();

    return {
      ok: true,
      email: auth.email
    };
  }

  if (message.type === "SIGN_OUT") {
    await stopCurrentActivity("signed_out");

    await chrome.storage.local.remove([
      "idToken",
      "refreshToken",
      "localId",
      "email",
      "tokenSavedAt"
    ]);

    await removeBlockingRule();

    return {
      ok: true
    };
  }

  if (message.type === "GET_STATUS") {
    const status = await getStatus();

    return {
      ok: true,
      status
    };
  }

  if (message.type === "SET_TRACKING_ENABLED") {
    await chrome.storage.local.set({
      trackingEnabled: Boolean(message.enabled)
    });

    await pushLocalSettingsToFirestore();

    if (!message.enabled) {
      await stopCurrentActivity("tracking_disabled");
    } else {
      const activeTabInfo = await getActiveTabInfo();

      if (activeTabInfo) {
        await handlePossibleActivityChange(activeTabInfo.tabId, activeTabInfo.windowId);
      }
    }

    return {
      ok: true
    };
  }

  return {
    ok: false,
    error: "Unknown message type."
  };
}

async function ensureDefaultSettings() {
  const stored = await chrome.storage.local.get([
    "trackingEnabled",
    "restrictionsEnabled",
    "trackFullUrls",
    "trackPageTitles",
    "allowedWindows"
  ]);

  const updates = {};

  if (stored.trackingEnabled === undefined) updates.trackingEnabled = true;
  if (stored.restrictionsEnabled === undefined) updates.restrictionsEnabled = false;
  if (stored.trackFullUrls === undefined) updates.trackFullUrls = false;
  if (stored.trackPageTitles === undefined) updates.trackPageTitles = false;
  if (!stored.allowedWindows) updates.allowedWindows = defaultAllowedWindows();

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function ensureUserSettingsInFirestore() {
  const auth = await getValidAuth();
  if (!auth) return;

  const remote = await fetchRemoteRules(auth).catch(() => null);

  if (remote) {
    await chrome.storage.local.set(remote);
    return;
  }

  await pushLocalSettingsToFirestore();
}

async function pushLocalSettingsToFirestore() {
  const auth = await getValidAuth();
  if (!auth) return;

  const settings = await getLocalSettings();

  const body = {
    fields: {
      trackingEnabled: {
        booleanValue: settings.trackingEnabled
      },
      restrictionsEnabled: {
        booleanValue: settings.restrictionsEnabled
      },
      trackFullUrls: {
        booleanValue: settings.trackFullUrls
      },
      trackPageTitles: {
        booleanValue: settings.trackPageTitles
      },
      allowedWindowsJson: {
        stringValue: JSON.stringify(settings.allowedWindows || defaultAllowedWindows())
      },
      updatedAtMs: {
        integerValue: String(Date.now())
      }
    }
  };

  await firestorePatch(`users/${auth.localId}/settings/browserRules`, body, auth.idToken);
}

async function getLocalSettings() {
  const stored = await chrome.storage.local.get([
    "trackingEnabled",
    "restrictionsEnabled",
    "trackFullUrls",
    "trackPageTitles",
    "allowedWindows"
  ]);

  return {
    trackingEnabled: stored.trackingEnabled !== false,
    restrictionsEnabled: stored.restrictionsEnabled === true,
    trackFullUrls: stored.trackFullUrls === true,
    trackPageTitles: stored.trackPageTitles === true,
    allowedWindows: stored.allowedWindows || defaultAllowedWindows()
  };
}

function defaultAllowedWindows() {
  return {
    sunday: [{ start: "05:00", end: "01:00" }],
    monday: [{ start: "05:00", end: "01:00" }],
    tuesday: [{ start: "05:00", end: "01:00" }],
    wednesday: [{ start: "05:00", end: "01:00" }],
    thursday: [{ start: "05:00", end: "01:00" }],
    friday: [{ start: "05:00", end: "01:00" }],
    saturday: [{ start: "05:00", end: "01:00" }]
  };
}

async function heartbeat() {
  const settings = await getLocalSettings();

  if (!settings.trackingEnabled) return;

  const idleState = await chrome.idle.queryState(IDLE_SECONDS);

  if (idleState !== "active") {
    await stopCurrentActivity(`heartbeat_${idleState}`);
    return;
  }

  const activeTabInfo = await getActiveTabInfo();

  if (!activeTabInfo) {
    await stopCurrentActivity("no_active_tab");
    return;
  }

  await handlePossibleActivityChange(activeTabInfo.tabId, activeTabInfo.windowId);
}

async function handlePossibleActivityChange(tabId, windowId) {
  const settings = await getLocalSettings();

  if (!settings.trackingEnabled) {
    await stopCurrentActivity("tracking_disabled");
    return;
  }

  const idleState = await chrome.idle.queryState(IDLE_SECONDS);

  if (idleState !== "active") {
    await stopCurrentActivity(`idle_${idleState}`);
    return;
  }

  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await stopCurrentActivity("tab_unavailable");
    return;
  }

  if (!tab || !tab.active || !isTrackableUrl(tab.url) || isBlockedPageUrl(tab.url)) {
    await stopCurrentActivity("untrackable_url");
    return;
  }

  const parsed = new URL(tab.url);
  const host = cleanHost(parsed.hostname);
  const safeUrl = settings.trackFullUrls ? tab.url : parsed.origin;
  const safeTitle = settings.trackPageTitles ? tab.title || "" : "";

  const changed =
    !state.active ||
    state.currentTabId !== tabId ||
    state.currentUrl !== safeUrl ||
    state.currentHost !== host;

  if (!changed) {
    await saveState();
    return;
  }

  await stopCurrentActivity("activity_changed");

  const now = Date.now();

  state.active = true;
  state.currentTabId = tabId;
  state.currentWindowId = windowId;
  state.currentUrl = safeUrl;
  state.currentHost = host;
  state.currentTitle = safeTitle;
  state.currentStartedAtMs = now;
  state.browser = detectBrowser();

  if (!state.currentSessionId) {
    state.currentSessionId = makeId();
    state.currentSessionStartedAtMs = now;
  }

  await saveState();
}

async function stopCurrentActivity(reason) {
  if (!state.active || !state.currentStartedAtMs || !state.currentHost) {
    state.active = false;
    await saveState();
    return;
  }

  const now = Date.now();
  const durationMs = now - state.currentStartedAtMs;

  if (durationMs >= MIN_SEGMENT_MS) {
    await writeSiteSegment({
      startedAtMs: state.currentStartedAtMs,
      endedAtMs: now,
      durationMs,
      url: state.currentUrl,
      host: state.currentHost,
      title: state.currentTitle || "",
      browser: state.browser,
      sessionId: state.currentSessionId || makeId(),
      reason
    });
  }

  const shouldEndSession =
    reason.includes("idle") ||
    reason.includes("unfocused") ||
    reason.includes("signed_out") ||
    reason.includes("tracking_disabled") ||
    reason.includes("no_active_tab");

  if (shouldEndSession && state.currentSessionId && state.currentSessionStartedAtMs) {
    const sessionDurationMs = now - state.currentSessionStartedAtMs;

    if (sessionDurationMs >= MIN_SEGMENT_MS) {
      await writeSession({
        sessionId: state.currentSessionId,
        startedAtMs: state.currentSessionStartedAtMs,
        endedAtMs: now,
        durationMs: sessionDurationMs,
        browser: state.browser,
        reason
      });
    }

    state.currentSessionId = null;
    state.currentSessionStartedAtMs = null;
  }

  state.active = false;
  state.currentTabId = null;
  state.currentWindowId = null;
  state.currentUrl = null;
  state.currentHost = null;
  state.currentTitle = null;
  state.currentStartedAtMs = null;

  await saveState();
}

async function writeSiteSegment(segment) {
  const auth = await getValidAuth();
  if (!auth) return;

  const docId = makeId();
  const dayKey = getDayKey(segment.startedAtMs);

  const body = {
    fields: {
      url: { stringValue: segment.url || "" },
      host: { stringValue: segment.host || "" },
      title: { stringValue: segment.title || "" },
      browser: { stringValue: segment.browser || detectBrowser() },
      sessionId: { stringValue: segment.sessionId || "" },
      startedAtMs: { integerValue: String(segment.startedAtMs) },
      endedAtMs: { integerValue: String(segment.endedAtMs) },
      durationMs: { integerValue: String(segment.durationMs) },
      dayKey: { stringValue: dayKey },
      reason: { stringValue: segment.reason || "" },
      createdAtMs: { integerValue: String(Date.now()) }
    }
  };

  await firestorePatch(`users/${auth.localId}/siteSegments/${docId}`, body, auth.idToken);
}

async function writeSession(session) {
  const auth = await getValidAuth();
  if (!auth) return;

  const dayKey = getDayKey(session.startedAtMs);

  const body = {
    fields: {
      browser: { stringValue: session.browser || detectBrowser() },
      startedAtMs: { integerValue: String(session.startedAtMs) },
      endedAtMs: { integerValue: String(session.endedAtMs) },
      durationMs: { integerValue: String(session.durationMs) },
      dayKey: { stringValue: dayKey },
      reason: { stringValue: session.reason || "" },
      createdAtMs: { integerValue: String(Date.now()) }
    }
  };

  await firestorePatch(`users/${auth.localId}/sessions/${session.sessionId}`, body, auth.idToken);
}

async function pullRemoteSettingsAndApplyRules() {
  const auth = await getValidAuth();

  if (auth) {
    const remote = await fetchRemoteRules(auth).catch(() => null);

    if (remote) {
      await chrome.storage.local.set(remote);
    }
  }

  await applyRulesFromLocalSettings();
}

async function applyRulesFromLocalSettings() {
  const settings = await getLocalSettings();

  if (!settings.restrictionsEnabled) {
    await removeBlockingRule();
    return;
  }

  const allowed = isNowAllowed(settings.allowedWindows || defaultAllowedWindows(), new Date());

  if (allowed) {
    await removeBlockingRule();
    return;
  }

  await applyBlockingRule();
  await redirectCurrentlyOpenNormalTabs();
}

async function applyBlockingRule() {
  const redirectUrl = chrome.runtime.getURL("blocked.html");

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BLOCK_RULE_ID],
    addRules: [
      {
        id: BLOCK_RULE_ID,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            url: redirectUrl
          }
        },
        condition: {
          regexFilter: "^https?://.*",
          resourceTypes: ["main_frame"],
          excludedRequestDomains: [
            "identitytoolkit.googleapis.com",
            "securetoken.googleapis.com",
            "firestore.googleapis.com"
          ]
        }
      }
    ]
  });
}

async function redirectCurrentlyOpenNormalTabs() {
  const blockedUrl = chrome.runtime.getURL("blocked.html");
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.id || !isTrackableUrl(tab.url)) continue;
    if (isBlockedPageUrl(tab.url)) continue;

    try {
      await chrome.tabs.update(tab.id, {
        url: blockedUrl
      });
    } catch {}
  }

  await stopCurrentActivity("restriction_started");
}

async function removeBlockingRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BLOCK_RULE_ID]
  });
}

function isNowAllowed(allowedWindows, now) {
  const dayName = getDayName(now);
  const previousDayName = getPreviousDayName(now);
  const minutes = now.getHours() * 60 + now.getMinutes();

  const todayWindows = allowedWindows[dayName] || [];

  for (const window of todayWindows) {
    if (isMinutesInWindow(minutes, window.start, window.end, false)) {
      return true;
    }
  }

  const previousWindows = allowedWindows[previousDayName] || [];

  for (const window of previousWindows) {
    if (isMinutesInWindow(minutes, window.start, window.end, true)) {
      return true;
    }
  }

  return false;
}

function isMinutesInWindow(minutes, startText, endText, previousDayOnly) {
  const start = timeTextToMinutes(startText);
  const end = timeTextToMinutes(endText);

  if (start === null || end === null) return false;

  if (start < end) {
    return !previousDayOnly && minutes >= start && minutes < end;
  }

  if (start > end) {
    if (previousDayOnly) {
      return minutes < end;
    }

    return minutes >= start;
  }

  return true;
}

function timeTextToMinutes(text) {
  if (!/^\d{2}:\d{2}$/.test(text || "")) return null;

  const [h, m] = text.split(":").map(Number);

  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  return h * 60 + m;
}

function getDayName(date) {
  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ][date.getDay()];
}

function getPreviousDayName(date) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() - 1);
  return getDayName(copy);
}

async function fetchRemoteRules(auth) {
  const response = await fetch(`${FIRESTORE_BASE}/users/${auth.localId}/settings/browserRules`, {
    headers: {
      Authorization: `Bearer ${auth.idToken}`
    }
  });

  if (!response.ok) return null;

  const data = await response.json();
  const fields = data.fields || {};

  return {
    trackingEnabled: fields.trackingEnabled?.booleanValue !== false,
    restrictionsEnabled: fields.restrictionsEnabled?.booleanValue === true,
    trackFullUrls: fields.trackFullUrls?.booleanValue === true,
    trackPageTitles: fields.trackPageTitles?.booleanValue === true,
    allowedWindows: safeParseJson(fields.allowedWindowsJson?.stringValue, defaultAllowedWindows())
  };
}

async function signInWithEmailPassword(email, password) {
  const response = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Could not sign in.");
  }

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    localId: data.localId,
    email: data.email
  };
}

async function getValidAuth() {
  const stored = await chrome.storage.local.get([
    "idToken",
    "refreshToken",
    "localId",
    "email",
    "tokenSavedAt"
  ]);

  if (!stored.idToken || !stored.refreshToken || !stored.localId) {
    return null;
  }

  const ageMs = Date.now() - Number(stored.tokenSavedAt || 0);
  const fiftyMinutesMs = 50 * 60 * 1000;

  if (ageMs < fiftyMinutesMs) {
    return stored;
  }

  try {
    return await refreshIdToken(stored.refreshToken);
  } catch {
    return stored;
  }
}

async function refreshIdToken(refreshToken) {
  const response = await fetch(`${TOKEN_BASE}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Could not refresh token.");
  }

  const updated = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    localId: data.user_id,
    email: data.email || "",
    tokenSavedAt: Date.now()
  };

  await chrome.storage.local.set(updated);

  return updated;
}

async function saveAuth(auth) {
  await chrome.storage.local.set({
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    localId: auth.localId,
    email: auth.email,
    tokenSavedAt: Date.now()
  });
}

async function firestorePatch(path, body, idToken) {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error?.message || "Firestore write failed.");
  }

  return data;
}

async function getStatus() {
  const auth = await getValidAuth();
  const settings = await getLocalSettings();
  const idleState = await chrome.idle.queryState(IDLE_SECONDS);

  return {
    signedIn: Boolean(auth),
    email: auth?.email || "",
    trackingEnabled: settings.trackingEnabled,
    restrictionsEnabled: settings.restrictionsEnabled,
    currentlyActive: state.active,
    currentHost: state.currentHost || "",
    idleState,
    browser: detectBrowser()
  };
}

async function getActiveTabInfo(windowId) {
  const query = {
    active: true,
    currentWindow: windowId === undefined
  };

  if (windowId !== undefined) {
    query.windowId = windowId;
  }

  const tabs = await chrome.tabs.query(query);

  if (!tabs || !tabs[0]) return null;

  return {
    tabId: tabs[0].id,
    windowId: tabs[0].windowId,
    tab: tabs[0]
  };
}

function isTrackableUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isBlockedPageUrl(url) {
  return String(url || "").startsWith(chrome.runtime.getURL("blocked.html"));
}

function cleanHost(host) {
  return String(host || "").replace(/^www\./, "").toLowerCase();
}

function getDayKey(timestampMs) {
  const shifted = new Date(timestampMs - FIVE_AM_SHIFT_MS);

  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function detectBrowser() {
  const ua = navigator.userAgent || "";

  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome/")) return "Chrome";

  return "Chromium";
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function safeParseJson(text, fallback) {
  try {
    if (!text) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function saveState() {
  await chrome.storage.session.set({
    trackerState: state
  });
}

async function restoreState() {
  const stored = await chrome.storage.session.get("trackerState");

  if (stored.trackerState) {
    state = {
      ...state,
      ...stored.trackerState
    };
  }
}
