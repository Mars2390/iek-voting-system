(function () {
  "use strict";

  var STORAGE_KEY = "eh_session_token";

  // Already logged in? Skip straight to the dashboard.
  var existingToken = localStorage.getItem(STORAGE_KEY);
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

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }
  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitLabel.textContent = loading ? "Logging in…" : "Log in";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();

    var displayName = document.getElementById("lg-name").value.trim();
    var membershipNumber = document.getElementById("lg-number").value.trim();

    if (!displayName) return showError("Enter your name.");
    if (!membershipNumber) return showError("Enter your membership number.");

    setLoading(true);

    fetch("/api/auth?action=login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: displayName, membershipNumber: membershipNumber }),
    })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        setLoading(false);
        if (!result.ok) {
          return showError(result.data.error || "Something went wrong. Please try again.");
        }
        localStorage.setItem(STORAGE_KEY, result.data.token);
        window.location.href = "/dashboard.html";
      })
      .catch(function () {
        setLoading(false);
        showError("Couldn't reach the server. Check your connection and try again.");
      });
  });
})();
