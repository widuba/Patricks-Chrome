const signedOut = document.getElementById("signedOut");
const signedIn = document.getElementById("signedIn");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const toggleTrackingBtn = document.getElementById("toggleTrackingBtn");

const signInMessage = document.getElementById("signInMessage");
const statusMessage = document.getElementById("statusMessage");

const emailText = document.getElementById("emailText");
const browserText = document.getElementById("browserText");
const trackingPill = document.getElementById("trackingPill");
const restrictionsPill = document.getElementById("restrictionsPill");
const currentSiteText = document.getElementById("currentSiteText");

let currentStatus = null;

document.addEventListener("DOMContentLoaded", refreshStatus);

signInBtn.addEventListener("click", async () => {
  signInMessage.textContent = "Signing in...";

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    signInMessage.textContent = "Enter your email and password.";
    return;
  }

  const response = await sendMessage({
    type: "SIGN_IN",
    email,
    password
  });

  if (!response.ok) {
    signInMessage.textContent = response.error || "Could not sign in.";
    return;
  }

  signInMessage.textContent = "";
  await refreshStatus();
});

signOutBtn.addEventListener("click", async () => {
  statusMessage.textContent = "Signing out...";

  await sendMessage({
    type: "SIGN_OUT"
  });

  statusMessage.textContent = "";
  await refreshStatus();
});

toggleTrackingBtn.addEventListener("click", async () => {
  if (!currentStatus) return;

  const enabled = !currentStatus.trackingEnabled;

  statusMessage.textContent = enabled ? "Resuming..." : "Pausing...";

  await sendMessage({
    type: "SET_TRACKING_ENABLED",
    enabled
  });

  statusMessage.textContent = "";
  await refreshStatus();
});

async function refreshStatus() {
  const response = await sendMessage({
    type: "GET_STATUS"
  });

  if (!response.ok) {
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
    return;
  }

  currentStatus = response.status;

  if (!currentStatus.signedIn) {
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
    return;
  }

  signedOut.classList.add("hidden");
  signedIn.classList.remove("hidden");

  emailText.textContent = currentStatus.email || "Account";
  browserText.textContent = currentStatus.browser || "Browser";
  currentSiteText.textContent = currentStatus.currentHost || "—";

  trackingPill.textContent = currentStatus.trackingEnabled ? "On" : "Off";
  trackingPill.classList.toggle("off", !currentStatus.trackingEnabled);

  restrictionsPill.textContent = currentStatus.restrictionsEnabled ? "On" : "Off";
  restrictionsPill.classList.toggle("off", !currentStatus.restrictionsEnabled);

  toggleTrackingBtn.textContent = currentStatus.trackingEnabled ? "Pause Tracking" : "Resume Tracking";
}

function sendMessage(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      resolve(response || {
        ok: false,
        error: "No response."
      });
    });
  });
}
