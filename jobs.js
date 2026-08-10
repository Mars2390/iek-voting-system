(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var myId = null;

  var listEl = document.getElementById("jobs-list");
  var minePanel = document.getElementById("jobs-mine-panel");
  var browsePanel = document.getElementById("jobs-browse-panel");
  var searchInput = document.getElementById("jobs-search");
  var disciplineSelect = document.getElementById("jobs-discipline");
  var typeSelect = document.getElementById("jobs-type");
  var locationInput = document.getElementById("jobs-location");
  var postBtn = document.getElementById("jobs-post-btn");
  var form = document.getElementById("jobs-form");
  var errorEl = document.getElementById("jobs-form-error");
  var debounceTimer = null;
  var knownDisciplines = [];
  var currentTab = "browse";

  function fmtSalary(j) {
    if (!j.salaryMin && !j.salaryMax) return "";
    var fmt = function (n) { return "KES " + Number(n).toLocaleString("en-KE"); };
    if (j.salaryMin && j.salaryMax) return fmt(j.salaryMin) + " – " + fmt(j.salaryMax) + "/mo";
    return fmt(j.salaryMin || j.salaryMax) + "/mo";
  }

  function jobCard(j, mine) {
    var meta = [j.companyName, j.location, j.jobType, j.discipline].filter(Boolean).join(" · ");
    var salary = fmtSalary(j);
    // "mine" is which tab/panel this card is rendering in, not whether
    // the viewer owns THIS job — the Browse tab lists everyone's jobs
    // including your own, so Apply has to be hidden by actual ownership
    // (postedById), not just by which panel is showing.
    var isOwner = mine || j.postedById === myId;
    var applyHtml = j.applyUrl
      ? '<a href="' + H.escapeHtml(j.applyUrl) + '" target="_blank" rel="noopener" class="eh-btn eh-btn-primary hub-btn-sm">Apply</a>'
      : j.applyEmail
      ? '<a href="mailto:' + H.escapeHtml(j.applyEmail) + '" class="eh-btn eh-btn-primary hub-btn-sm">Apply</a>'
      : "";
    var deleteHtml = isOwner ? '<button class="eh-btn eh-btn-ghost-light hub-btn-sm" data-remove="' + j.id + '">Remove</button>' : "";
    return (
      '<div class="hub-card hub-job-card">' +
      "<h3>" + H.escapeHtml(j.title) + "</h3>" +
      '<p class="meta">' + H.escapeHtml(meta) + (salary ? " · " + H.escapeHtml(salary) : "") + "</p>" +
      '<p class="desc">' + H.escapeHtml(j.description) + "</p>" +
      '<div class="foot">' +
      '<span class="posted-by">Posted by ' + H.escapeHtml(j.postedBy) + " · " + H.timeAgo(j.createdAt) + "</span>" +
      '<div style="display:flex;gap:8px;">' + (isOwner ? "" : applyHtml) + deleteHtml + "</div>" +
      "</div></div>"
    );
  }

  function load() {
    H.api("jobs", { query: { q: searchInput.value.trim(), discipline: disciplineSelect.value, jobType: typeSelect.value, location: locationInput.value.trim() } })
      .then(function (data) {
        if (!data.jobs.length) {
          listEl.innerHTML = '<div class="hub-empty">No jobs match your filters yet.</div>';
          return;
        }
        listEl.innerHTML = data.jobs.map(function (j) { return jobCard(j, false); }).join("");
        wireRemove(listEl);

        data.jobs.forEach(function (j) {
          if (j.discipline && knownDisciplines.indexOf(j.discipline) === -1) {
            knownDisciplines.push(j.discipline);
            var opt = document.createElement("option");
            opt.value = j.discipline;
            opt.textContent = j.discipline;
            disciplineSelect.appendChild(opt);
          }
        });
      })
      .catch(function (err) { listEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; });
  }

  function loadMine() {
    H.api("jobs", { query: { mine: "1" } }).then(function (data) {
      document.getElementById("jobs-mine-count").textContent = data.jobs.length ? "(" + data.jobs.length + ")" : "";
      minePanel.innerHTML = data.jobs.length
        ? '<div class="hub-list">' + data.jobs.map(function (j) { return jobCard(j, true); }).join("") + "</div>"
        : '<div class="hub-empty">You haven\'t posted any jobs yet.</div>';
      wireRemove(minePanel);
    });
  }

  function wireRemove(scope) {
    scope.querySelectorAll("[data-remove]").forEach(function (b) {
      b.addEventListener("click", function () {
        H.confirm({ message: "This removes it from the jobs board for everyone." }).then(function (ok) {
          if (!ok) return;
          H.api("jobs", { method: "DELETE", query: { id: b.dataset.remove } }).then(function () {
            if (currentTab === "mine") loadMine();
            else load();
          }).catch(function (err) { H.toast(err.message, true); });
        });
      });
    });
  }

  [searchInput, locationInput].forEach(function (el) {
    el.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(load, 300);
    });
  });
  disciplineSelect.addEventListener("change", load);
  typeSelect.addEventListener("change", load);

  document.querySelectorAll(".hub-tab[data-jobtab]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".hub-tab[data-jobtab]").forEach(function (t) { t.classList.remove("is-active"); });
      tab.classList.add("is-active");
      currentTab = tab.dataset.jobtab;
      browsePanel.hidden = currentTab !== "browse";
      listEl.hidden = currentTab !== "browse";
      form.hidden = true;
      minePanel.hidden = currentTab !== "mine";
      if (currentTab === "mine") loadMine();
    });
  });

  postBtn.addEventListener("click", function () { form.hidden = !form.hidden; });
  document.getElementById("jobs-form-cancel").addEventListener("click", function () { form.hidden = true; form.reset(); errorEl.hidden = true; });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var body = {
      title: document.getElementById("job-title").value.trim(),
      companyName: document.getElementById("job-company").value.trim(),
      location: document.getElementById("job-location").value.trim(),
      jobType: document.getElementById("job-type").value,
      discipline: document.getElementById("job-discipline").value.trim(),
      description: document.getElementById("job-description").value.trim(),
      applyUrl: document.getElementById("job-apply-url").value.trim(),
      applyEmail: document.getElementById("job-apply-email").value.trim(),
      salaryMin: document.getElementById("job-salary-min").value,
      salaryMax: document.getElementById("job-salary-max").value,
    };
    H.api("jobs", { method: "POST", body: body })
      .then(function () {
        form.hidden = true;
        form.reset();
        H.toast("Job posted");
        load();
      })
      .catch(function (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      });
  });

  H.api("me").then(function (data) { myId = data.engineer.id; load(); }).catch(load);
})();
