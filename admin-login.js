(function () {
  "use strict";

  // Deliberately a different localStorage key from the engineer session
  // (eh_session_token) — admin and member auth must never be able to
  // collide or be confused for one another.
  var STORAGE_KEY = "eh_admin_token";

  var existingToken = localStorage.getItem(STORAGE_KEY);
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
        localStorage.setItem(STORAGE_KEY, result.data.token);
        window.location.href = "/admin.html";
      })
      .catch(function () {
        setLoading(false);
        showError("Couldn't reach the server. Check your connection and try again.");
      });
  });
})();
