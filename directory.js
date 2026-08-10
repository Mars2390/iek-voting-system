(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var searchInput = document.getElementById("dir-search");
  var disciplineSelect = document.getElementById("dir-discipline");
  var sortSelect = document.getElementById("dir-sort");
  var grid = document.getElementById("dir-grid");
  var countEl = document.getElementById("dir-count");
  var loadMoreWrap = document.getElementById("dir-loadmore-wrap");
  var loadMoreBtn = document.getElementById("dir-loadmore");

  var PAGE_SIZE = 24;
  var offset = 0;
  var total = 0;
  var disciplinesLoaded = false;
  var debounceTimer = null;

  // "Connect easily" — a directory card used to only link through to the
  // full profile page to send a request; putting the action right on
  // the card (matching every other professional network) saves that
  // extra hop for the common case.
  function personCard(e) {
    var role = [e.title, e.company].filter(Boolean).join(" at ") || e.discipline || "";
    var action;
    if (e.connectionStatus === "connected") {
      action = '<a href="/messages.html?with=' + e.id + '" class="eh-btn eh-btn-ghost-light hub-btn-sm dir-action-btn" data-stop>Message</a>';
    } else if (e.connectionStatus === "pending_outgoing") {
      action = '<span class="eh-btn eh-btn-ghost-light hub-btn-sm dir-action-btn is-disabled">Pending</span>';
    } else if (e.connectionStatus === "pending_incoming") {
      action = '<a href="/connections.html" class="eh-btn eh-btn-primary hub-btn-sm dir-action-btn" data-stop>Respond</a>';
    } else {
      action = '<button type="button" class="eh-btn eh-btn-primary hub-btn-sm dir-action-btn" data-connect="' + e.id + '">+ Connect</button>';
    }
    return (
      '<a href="/profile.html?id=' + e.id + '" class="hub-person-card">' +
      H.avatarHtml(e, "lg") +
      "<h3>" + H.escapeHtml(e.displayName) + "</h3>" +
      '<p class="role">' + H.escapeHtml(role) + "</p>" +
      '<div class="badge-row"><span class="hub-verified-badge">Verified</span></div>' +
      '<div class="dir-action-wrap">' + action + "</div>" +
      "</a>"
    );
  }

  function wireCardActions() {
    // The action sits inside the card's own <a href="/profile...">, so
    // any click on it has to stop the click from bubbling to that
    // anchor and navigating away instead of doing the action.
    grid.querySelectorAll("[data-stop]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });
    grid.querySelectorAll("[data-connect]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var id = Number(btn.dataset.connect);
        btn.disabled = true;
        H.api("connections", { method: "POST", body: { addresseeId: id } })
          .then(function () {
            btn.textContent = "Pending";
            btn.classList.remove("eh-btn-primary");
            btn.classList.add("eh-btn-ghost-light", "is-disabled");
            H.toast("Connection request sent");
          })
          .catch(function (err) {
            btn.disabled = false;
            H.toast(err.message, true);
          });
      });
    });
  }

  function search(reset) {
    if (reset) offset = 0;
    H.api("directory", {
      query: {
        q: searchInput.value.trim(),
        discipline: disciplineSelect.value,
        sort: sortSelect.value,
        limit: PAGE_SIZE,
        offset: offset,
      },
    })
      .then(function (data) {
        total = data.total;
        if (reset) grid.innerHTML = "";
        grid.insertAdjacentHTML("beforeend", data.engineers.map(personCard).join(""));
        wireCardActions();
        offset += data.engineers.length;
        countEl.textContent = total + " engineer" + (total === 1 ? "" : "s") + (searchInput.value.trim() ? ' matching "' + searchInput.value.trim() + '"' : "");
        loadMoreWrap.hidden = offset >= total;

        if (!disciplinesLoaded && data.disciplines.length) {
          disciplinesLoaded = true;
          data.disciplines.forEach(function (d) {
            var opt = document.createElement("option");
            opt.value = d;
            opt.textContent = d;
            disciplineSelect.appendChild(opt);
          });
        }
        if (!data.engineers.length && reset) {
          grid.innerHTML = '<div class="hub-empty" style="grid-column:1/-1;">No engineers match that search.</div>';
        }
      })
      .catch(function (err) {
        grid.innerHTML = '<div class="hub-empty" style="grid-column:1/-1;">' + H.escapeHtml(err.message) + "</div>";
      });
  }

  searchInput.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { search(true); }, 300);
  });
  disciplineSelect.addEventListener("change", function () { search(true); });
  sortSelect.addEventListener("change", function () { search(true); });
  loadMoreBtn.addEventListener("click", function () { search(false); });

  var urlQuery = new URLSearchParams(window.location.search).get("q");
  if (urlQuery) searchInput.value = urlQuery;
  search(true);
})();
