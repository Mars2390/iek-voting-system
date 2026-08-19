(function () {
  "use strict";

  var STORAGE_KEY = "eh_session_token";
  var REMEMBER_KEY = "eh_remembered_number";

  // localStorage can throw instead of just returning null in real
  // mobile contexts — Safari Private Browsing, and critically, WhatsApp/
  // Facebook/Instagram in-app browser webviews, which is exactly how a
  // link to this app spreads in practice. This was a real, confirmed
  // bug: the unguarded read below used to run before the submit handler
  // was even registered, so on any browser where it threw, the entire
  // script died right there — the login form rendered but tapping
  // Continue did nothing at all, which is what "the app crashes on
  // mobile" turned out to actually be.
  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // Already logged in? Skip straight to the dashboard.
  var existingToken = safeStorageGet(STORAGE_KEY);
  if (existingToken) {
    fetch("/api/auth?action=me", {
      headers: { Authorization: "Bearer " + existingToken },
    })
      .then(function (r) { return r.ok ? window.location.replace("/dashboard.html") : null; })
      .catch(function () {});
  }

  var form = document.getElementById("lg-form");
  var errorBox = document.getElementById("lg-error");
  var submitBtn = document.getElementById("lg-submit");
  var submitLabel = submitBtn.querySelector(".lg-submit-label");
  var subEl = document.getElementById("lg-sub");
  var nameGroup = document.getElementById("lg-name-group");
  var numberGroup = document.getElementById("lg-number-group");
  var pinGroup = document.getElementById("lg-pin-group");
  var pinLabel = document.getElementById("lg-pin-label");
  var pinHint = document.getElementById("lg-pin-hint");
  var pinInput = document.getElementById("lg-pin");
  var pinConfirmGroup = document.getElementById("lg-pin-confirm-group");
  var pinConfirmInput = document.getElementById("lg-pin-confirm");

  // "credentials": asking for name + membership number.
  // "setup-pin": account has no PIN yet — this login sets one.
  // "enter-pin": account already has a PIN — this login checks it.
  var mode = "credentials";

  // The membership number isn't sensitive on its own (it's the
  // username, not the secret — the PIN is what actually protects the
  // account), so remembering it locally for a faster return visit is
  // safe. The PIN itself is never stored here; autocomplete tokens
  // below let the browser's OWN password manager offer to remember
  // that part, which is the appropriate place for a secret to live.
  var rememberedNumber = safeStorageGet(REMEMBER_KEY);
  if (rememberedNumber) document.getElementById("lg-number").value = rememberedNumber;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }
  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitLabel.textContent = loading ? "Please wait…" : mode === "credentials" ? "Continue" : "Log in";
  }

  function enterSetupPinMode() {
    mode = "setup-pin";
    subEl.textContent = "Create a PIN — you'll use it with your membership number every time you log in.";
    nameGroup.hidden = true;
    numberGroup.hidden = true;
    pinLabel.textContent = "Create a PIN";
    pinHint.textContent = "Pick 4-6 digits. Don't share it — this is what protects your account.";
    pinGroup.hidden = false;
    pinConfirmGroup.hidden = false;
    submitLabel.textContent = "Create PIN & log in";
    pinInput.value = "";
    pinConfirmInput.value = "";
    // Same field the "enter-pin" step reuses as current-password — a
    // browser autofill dropdown offering an old PIN while setting a new
    // one would be actively wrong here, so this only applies for the
    // duration of this mode.
    pinInput.autocomplete = "new-password";
    pinInput.focus();
  }

  function enterEnterPinMode() {
    mode = "enter-pin";
    subEl.textContent = "Enter your PIN to finish logging in.";
    nameGroup.hidden = true;
    numberGroup.hidden = true;
    pinLabel.textContent = "PIN";
    pinHint.textContent = "";
    pinGroup.hidden = false;
    pinConfirmGroup.hidden = true;
    submitLabel.textContent = "Log in";
    pinInput.value = "";
    pinInput.autocomplete = "current-password";
    pinInput.focus();
  }

  function resetToCredentials() {
    mode = "credentials";
    subEl.textContent = "Use your IEK membership number and PIN.";
    nameGroup.hidden = false;
    numberGroup.hidden = false;
    pinGroup.hidden = true;
    pinConfirmGroup.hidden = true;
    submitLabel.textContent = "Continue";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();

    var displayName = document.getElementById("lg-name").value.trim();
    var membershipNumber = document.getElementById("lg-number").value.trim();
    var pin = pinInput.value.trim();

    if (mode === "credentials") {
      if (!displayName) return showError("Enter your name.");
      if (!membershipNumber) return showError("Enter your membership number.");
    } else if (mode === "setup-pin") {
      if (!/^[0-9]{4,6}$/.test(pin)) return showError("PIN must be 4-6 digits.");
      if (pin !== pinConfirmInput.value.trim()) return showError("PINs don't match.");
    } else {
      if (!/^[0-9]{4,6}$/.test(pin)) return showError("Enter your PIN.");
    }

    setLoading(true);

    var body = { displayName: displayName, membershipNumber: membershipNumber };
    if (mode !== "credentials") body.pin = pin;

    fetch("/api/auth?action=login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (result) {
        setLoading(false);
        if (!result.ok) {
          showError(result.data.error || "Something went wrong. Please try again.");
          // A wrong/expired PIN stays on the PIN step so they don't have
          // to retype their name and number — anything else (account not
          // found, lockout) goes back to the start.
          if (mode !== "enter-pin") resetToCredentials();
          else pinInput.value = "";
          return;
        }
        if (result.data.needsPinSetup) return enterSetupPinMode();
        if (result.data.needsPin) return enterEnterPinMode();
        // The login itself succeeded server-side — but if the token
        // can't actually be saved (storage blocked), redirecting to
        // dashboard.html would just bounce straight back here, since
        // requireAuth() would find no token there either. An infinite
        // silent loop is worse than telling the user plainly what's
        // wrong and how to fix it.
        try {
          localStorage.setItem(STORAGE_KEY, result.data.token);
          localStorage.setItem(REMEMBER_KEY, membershipNumber);
        } catch (e) {
          showError("Your browser is blocking this site from staying signed in — common in the WhatsApp/Facebook in-app browser or Private Browsing. Open this link in Safari or Chrome directly instead.");
          return;
        }
        window.location.href = "/dashboard.html";
      })
      .catch(function () {
        setLoading(false);
        showError("Couldn't reach the server. Check your connection and try again.");
      });
  });
})();
