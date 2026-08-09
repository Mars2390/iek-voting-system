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

  function personCard(e) {
    var role = [e.title, e.company].filter(Boolean).join(" at ") || e.discipline || "";
    return (
      '<a href="/profile.html?id=' + e.id + '" class="hub-person-card">' +
      H.avatarHtml(e, "lg") +
      "<h3>" + H.escapeHtml(e.displayName) + "</h3>" +
      '<p class="role">' + H.escapeHtml(role) + "</p>" +
      '<div class="badge-row"><span class="hub-verified-badge">Verified</span></div>' +
      "</a>"
    );
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
