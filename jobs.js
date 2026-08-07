(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var myId = null;

  var listEl = document.getElementById("jobs-list");
  var searchInput = document.getElementById("jobs-search");
  var disciplineSelect = document.getElementById("jobs-discipline");
  var postBtn = document.getElementById("jobs-post-btn");
  var form = document.getElementById("jobs-form");
  var errorEl = document.getElementById("jobs-form-error");
  var debounceTimer = null;
  var knownDisciplines = [];

  function jobCard(j) {
    var meta = [j.companyName, j.location, j.jobType, j.discipline].filter(Boolean).join(" · ");
    var applyHtml = j.applyUrl
      ? '<a href="' + H.escapeHtml(j.applyUrl) + '" target="_blank" rel="noopener" class="eh-btn eh-btn-primary hub-btn-sm">Apply</a>'
      : j.applyEmail
      ? '<a href="mailto:' + H.escapeHtml(j.applyEmail) + '" class="eh-btn eh-btn-primary hub-btn-sm">Apply</a>'
      : "";
    var deleteHtml = j.postedById === myId ? '<button class="eh-btn eh-btn-ghost-light hub-btn-sm" data-remove="' + j.id + '">Remove</button>' : "";
    return (
      '<div class="hub-card hub-job-card">' +
      "<h3>" + H.escapeHtml(j.title) + "</h3>" +
      '<p class="meta">' + H.escapeHtml(meta) + "</p>" +
      '<p class="desc">' + H.escapeHtml(j.description) + "</p>" +
      '<div class="foot">' +
      '<span class="posted-by">Posted by ' + H.escapeHtml(j.postedBy) + " · " + H.timeAgo(j.createdAt) + "</span>" +
      '<div style="display:flex;gap:8px;">' + applyHtml + deleteHtml + "</div>" +
      "</div></div>"
    );
  }

  function load() {
    H.api("jobs", { query: { q: searchInput.value.trim(), discipline: disciplineSelect.value } })
      .then(function (data) {
        if (!data.jobs.length) {
          listEl.innerHTML = '<div class="hub-empty">No jobs posted yet. Be the first to share an opening.</div>';
          return;
        }
        listEl.innerHTML = data.jobs.map(jobCard).join("");
        listEl.querySelectorAll("[data-remove]").forEach(function (b) {
          b.addEventListener("click", function () {
            if (!window.confirm("Remove this job posting?")) return;
            H.api("jobs", { method: "DELETE", query: { id: b.dataset.remove } }).then(load).catch(function (err) { H.toast(err.message, true); });
          });
        });

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

  searchInput.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  });
  disciplineSelect.addEventListener("change", load);

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
