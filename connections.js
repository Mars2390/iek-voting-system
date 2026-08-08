(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var tabs = document.querySelectorAll(".hub-tab");
  var panels = {
    connections: document.getElementById("panel-connections"),
    incoming: document.getElementById("panel-incoming"),
    outgoing: document.getElementById("panel-outgoing"),
  };

  function personRow(p, actionsHtml) {
    var role = [p.title, p.company].filter(Boolean).join(" at ");
    return (
      '<div class="hub-req-row" data-id="' + p.id + '" data-connid="' + p.connectionId + '">' +
      '<a href="/profile.html?id=' + p.id + '">' + H.avatarHtml(p, "md") + "</a>" +
      '<div class="hub-req-info">' +
      '<a href="/profile.html?id=' + p.id + '" style="color:inherit;"><h4>' + H.escapeHtml(p.displayName) + "</h4></a>" +
      (role ? '<p class="sub">' + H.escapeHtml(role) + "</p>" : "") +
      "</div>" +
      '<div class="hub-req-actions">' + actionsHtml + "</div>" +
      "</div>"
    );
  }

  function load() {
    H.api("connections")
      .then(function (data) {
        document.getElementById("tab-count-connections").textContent = data.connections.length ? "(" + data.connections.length + ")" : "";
        document.getElementById("tab-count-incoming").textContent = data.incoming.length ? "(" + data.incoming.length + ")" : "";
        document.getElementById("tab-count-outgoing").textContent = data.outgoing.length ? "(" + data.outgoing.length + ")" : "";
        document.getElementById("net-stat-connections").textContent = data.connections.length;
        document.getElementById("net-stat-incoming").textContent = data.incoming.length;
        document.getElementById("net-stat-outgoing").textContent = data.outgoing.length;

        panels.connections.innerHTML = data.connections.length
          ? data.connections.map(function (p) { return personRow(p, '<a href="/profile.html?id=' + p.id + '" class="eh-btn eh-btn-ghost-light hub-btn-sm">View</a>'); }).join("")
          : '<div class="hub-empty">No connections yet. Visit the <a href="/directory.html">directory</a> to find people you know.</div>';

        panels.incoming.innerHTML = data.incoming.length
          ? data.incoming
              .map(function (p) {
                return personRow(
                  p,
                  '<button class="eh-btn eh-btn-primary hub-btn-sm" data-accept="' + p.connectionId + '">Accept</button>' +
                    '<button class="eh-btn eh-btn-ghost-light hub-btn-sm" data-decline="' + p.connectionId + '">Decline</button>'
                );
              })
              .join("")
          : '<div class="hub-empty">No pending requests.</div>';

        panels.outgoing.innerHTML = data.outgoing.length
          ? data.outgoing.map(function (p) { return personRow(p, '<button class="eh-btn eh-btn-ghost-light hub-btn-sm" data-cancel="' + p.connectionId + '">Cancel</button>'); }).join("")
          : '<div class="hub-empty">No outgoing requests.</div>';

        wireActions();
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  function wireActions() {
    document.querySelectorAll("[data-accept]").forEach(function (b) {
      b.addEventListener("click", function () { respond(b.dataset.accept, "accepted"); });
    });
    document.querySelectorAll("[data-decline]").forEach(function (b) {
      b.addEventListener("click", function () { respond(b.dataset.decline, "declined"); });
    });
    document.querySelectorAll("[data-cancel]").forEach(function (b) {
      b.addEventListener("click", function () {
        H.api("connections", { method: "DELETE", query: { id: b.dataset.cancel } }).then(load).catch(function (err) { H.toast(err.message, true); });
      });
    });
  }
  function respond(id, status) {
    H.api("connections", { method: "PATCH", body: { id: Number(id), status: status } })
      .then(function () { H.toast(status === "accepted" ? "Connected!" : "Declined"); load(); })
      .catch(function (err) { H.toast(err.message, true); });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.classList.remove("is-active"); });
      tab.classList.add("is-active");
      Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== tab.dataset.tab; });
    });
  });

  load();
})();
