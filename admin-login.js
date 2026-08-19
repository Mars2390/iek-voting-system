(function () {
  "use strict";

  // Deliberately a different localStorage key from the engineer session
  // (eh_session_token) — admin and member auth must never be able to
  // collide or be confused for one another.
  var STORAGE_KEY = "eh_admin_token";

  // localStorage can throw instead of just returning null in real
  // mobile contexts (Safari Private Browsing, WhatsApp/Facebook/
  // Instagram in-app browsers) — an uncaught throw here would kill this
  // whole script before the submit handler below is even registered,
  // same bug class found and fixed in login.js.
  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var existingToken = safeStorageGet(STORAGE_KEY);
  if (existingToken) {
    fetch("/api/auth?action=admin-me", { headers: { Authorization: "Bearer " + existingToken } })
      .then(function (r) { return r.ok ? window.location.replace("/admin.html") : null; })
      .catch(function () {});
  }

  var form = document.getElementById("ad-form");
  var errorBox = document.getElementById("ad-error");
  var submitBtn = document.getElementById("ad-submit");
  var submitLabel = submitBtn.querySelector(".lg-submit-label");

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }
  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitLabel.textContent = loading ? "Signing in…" : "Sign in";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();

    var email = document.getElementById("ad-email").value.trim();
    var pin = document.getElementById("ad-pin").value.trim();
    if (!email || !pin) return showError("Enter your email and PIN.");

    setLoading(true);

    fetch("/api/auth?action=admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, pin: pin }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        setLoading(false);
        if (!result.ok) return showError(result.data.error || "Something went wrong. Please try again.");
        try {
          localStorage.setItem(STORAGE_KEY, result.data.token);
        } catch (e) {
          showError("Your browser is blocking this site from staying signed in (common in Private Browsing). Try a normal browser tab.");
          return;
        }
        window.location.href = "/admin.html";
      })
      .catch(function () {
        setLoading(false);
        showError("Couldn't reach the server. Check your connection and try again.");
      });
  });
})();
