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
