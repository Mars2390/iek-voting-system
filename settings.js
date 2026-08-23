(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  H.api("me").then(function (data) {
    var e = data.engineer;
    var rows = [
      ["Name", e.displayName],
      ["Membership number", e.iekNumber],
      ["Phone", e.phone || "Not on file"],
      ["Last login", e.lastLogin ? new Date(e.lastLogin).toLocaleString("en-GB") : "—"],
    ];
    document.getElementById("settings-account").innerHTML = rows
      .map(function (r) { return '<div class="row"><dt>' + r[0] + "</dt><dd>" + H.escapeHtml(r[1]) + "</dd></div>"; })
      .join("");

    document.getElementById("settings-consent-marketing").checked = !!e.consentMarketing;
    document.getElementById("settings-consent-data-meta").textContent = e.consentDataAt
      ? "Given on " + new Date(e.consentDataAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })
      : "";
  });

  document.getElementById("settings-consent-save").addEventListener("click", function () {
    var btn = this;
    var msg = document.getElementById("settings-consent-msg");
    msg.hidden = true;
    btn.disabled = true;
    var wantsMarketing = document.getElementById("settings-consent-marketing").checked;
    H.api("consent", { method: "POST", body: { consentMarketing: wantsMarketing } })
      .then(function () { H.toast("Preferences saved."); })
      .catch(function (err) {
        msg.textContent = err.message;
        msg.hidden = false;
      })
      .finally(function () { btn.disabled = false; });
  });

  document.getElementById("settings-logout-all").addEventListener("click", function () {
    H.confirm({ title: "Sign out everywhere?", message: "This signs you out on every device, including this one.", confirmText: "Sign out everywhere" }).then(function (ok) {
      if (!ok) return;
      H.api("logout-all", { method: "POST" }).finally(function () {
        H.storageRemove("eh_session_token");
        window.location.href = "/login.html";
      });
    });
  });
})();
