(function () {
  "use strict";

  // localStorage can throw instead of just returning null in real
  // mobile contexts (Safari Private Browsing, WhatsApp/Facebook/
  // Instagram in-app browsers) — an uncaught throw here would kill this
  // whole script before anything below it runs, same bug class found
  // and fixed in login.js.
  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeStorageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  var STORAGE_KEY = "eh_admin_token";
  var token = safeStorageGet(STORAGE_KEY);
  if (!token) {
    window.location.replace("/admin-login.html");
    return;
  }

  function adminApi(action, options) {
    options = options || {};
    var params = new URLSearchParams(Object.assign({ action: action }, options.query || {}));
    var headers = Object.assign({ Authorization: "Bearer " + token }, options.headers || {});
    var isBinary = options.body instanceof Blob || options.body instanceof ArrayBuffer || options.body instanceof File;
    if (options.body && !isBinary && typeof options.body === "object") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    return fetch("/api/auth?" + params.toString(), { method: options.method || "GET", headers: headers, body: options.body }).then(function (r) {
      if (r.status === 401) {
        safeStorageRemove(STORAGE_KEY);
        window.location.replace("/admin-login.html");
        return new Promise(function () {});
      }
      return r.json().then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || "Request failed"), { data: data });
        return data;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function timeAgo(dateStr) {
    if (!dateStr) return "Never";
    var diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 2592000) return Math.floor(diff / 86400) + "d ago";
    return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function toast(message, isError) {
    var el = document.createElement("div");
    el.textContent = message;
    el.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;" +
      "background:" + (isError ? "#bb0a1e" : "#101a24") + ";color:#fff;padding:12px 22px;" +
      "border-radius:999px;font-size:13.5px;font-weight:600;box-shadow:0 12px 28px -12px rgba(10,10,10,0.4);" +
      "opacity:0;transition:opacity 0.25s;";
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = "1"; });
    setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 300); }, 2600);
  }

  adminApi("admin-me").then(function (d) { document.getElementById("ad-email").textContent = d.email; });

  document.getElementById("ad-logout").addEventListener("click", function () {
    adminApi("admin-logout", { method: "POST" }).finally(function () {
      safeStorageRemove(STORAGE_KEY);
      window.location.href = "/admin-login.html";
    });
  });

  // ---------- Engineers table ----------
  var tbody = document.getElementById("ad-table-body");
  var searchInput = document.getElementById("ad-search");
  var loadMoreBtn = document.getElementById("ad-loadmore");
  var LIMIT = 50;
  var offset = 0;
  var searchTimer = null;

  function rowHtml(e) {
    return (
      "<tr data-id=\"" + e.id + "\">" +
      "<td>" + escapeHtml(e.name) + "</td>" +
      "<td>" + escapeHtml(e.iekNumber) + "</td>" +
      '<td><span class="ad-status-dot' + (e.isActiveNow ? " is-online" : "") + '"><span class="dot"></span>' + (e.isActiveNow ? "Online" : "Offline") + "</span></td>" +
      "<td>" + escapeHtml(timeAgo(e.lastActive)) + "</td>" +
      "<td>" + escapeHtml(timeAgo(e.lastLogin)) + "</td>" +
      '<td><button type="button" class="ad-edit-btn" data-edit="' + e.id + '" data-name="' + escapeHtml(e.name) + '" data-number="' + escapeHtml(e.iekNumber) + '">Edit</button></td>' +
      "</tr>"
    );
  }

  function loadStats() {
    adminApi("admin-engineers", { query: { limit: 1 } }).then(function (d) {
      document.getElementById("ad-stat-total").textContent = d.total;
      document.getElementById("ad-stat-active").textContent = d.activeNow;
    });
  }

  // Two different triggers can call loadEngineers(true) close together
  // (an import finishing while the user is mid-search, e.g.) — only the
  // response to the most recently issued request is allowed to touch
  // the table, so a slower earlier response can't clobber a fresher one
  // with stale/wrongly-filtered rows.
  var loadEngineersSeq = 0;
  function loadEngineers(reset) {
    if (reset) offset = 0;
    var q = searchInput.value.trim();
    var seq = ++loadEngineersSeq;
    adminApi("admin-engineers", { query: { q: q, limit: LIMIT, offset: offset } }).then(function (d) {
      if (seq !== loadEngineersSeq) return;
      if (reset) tbody.innerHTML = "";
      if (!d.engineers.length && reset) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="hub-empty">No engineers found.</div></td></tr>';
      } else {
        tbody.insertAdjacentHTML("beforeend", d.engineers.map(rowHtml).join(""));
      }
      offset += d.engineers.length;
      loadMoreBtn.hidden = d.engineers.length < LIMIT;
      wireEditButtons();
    });
  }
  loadMoreBtn.addEventListener("click", function () { loadEngineers(false); });
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { loadEngineers(true); }, 300);
  });

  function wireEditButtons() {
    tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
      btn.onclick = function () { openEdit(btn.dataset.edit, btn.dataset.name, btn.dataset.number); };
    });
  }

  // ---------- Edit modal ----------
  var editOverlay = document.getElementById("ad-edit-overlay");
  var editForm = document.getElementById("ad-edit-form");
  var editError = document.getElementById("ad-edit-error");

  function openEdit(id, name, number) {
    document.getElementById("ad-edit-id").value = id;
    document.getElementById("ad-edit-name").value = name;
    document.getElementById("ad-edit-number").value = number;
    editError.hidden = true;
    editOverlay.hidden = false;
  }
  function closeEdit() { editOverlay.hidden = true; }
  document.getElementById("ad-edit-close").addEventListener("click", closeEdit);
  document.getElementById("ad-edit-cancel").addEventListener("click", closeEdit);
  editOverlay.addEventListener("click", function (e) { if (e.target === editOverlay) closeEdit(); });

  editForm.addEventListener("submit", function (e) {
    e.preventDefault();
    editError.hidden = true;
    var id = Number(document.getElementById("ad-edit-id").value);
    var name = document.getElementById("ad-edit-name").value.trim();
    var iekNumber = document.getElementById("ad-edit-number").value.trim();
    adminApi("admin-engineers", { method: "PUT", body: { id: id, name: name, iekNumber: iekNumber } })
      .then(function () {
        closeEdit();
        toast("Saved");
        loadEngineers(true);
      })
      .catch(function (err) {
        editError.textContent = err.message;
        editError.hidden = false;
      });
  });

  // ---------- Import ----------
  var importInput = document.getElementById("ad-import-input");
  var importLabel = document.getElementById("ad-file-label");
  var importBtn = document.getElementById("ad-import-btn");
  var importResult = document.getElementById("ad-import-result");
  var pendingFile = null;

  document.querySelector(".ad-file-btn").addEventListener("click", function (e) {
    // the <input> itself is the click target when clicking directly on it — avoid double-opening
    if (e.target !== importInput) importInput.click();
  });
  importInput.addEventListener("change", function () {
    pendingFile = importInput.files[0] || null;
    importLabel.textContent = pendingFile ? pendingFile.name : "Choose CSV or Excel file…";
    importBtn.disabled = !pendingFile;
    importResult.hidden = true;
  });

  importBtn.addEventListener("click", function () {
    if (!pendingFile) return;
    var originalLabel = importBtn.textContent;
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
    adminApi("admin-import", { method: "POST", headers: { "Content-Type": pendingFile.type || "application/octet-stream" }, body: pendingFile })
      .then(function (d) {
        var html = '<div class="summary">Imported ' + d.importedCount + " engineer" + (d.importedCount === 1 ? "" : "s") + (d.skippedCount ? ", skipped " + d.skippedCount : "") + ".</div>";
        if (d.skipped.length) {
          html += '<div class="skip-list">' + d.skipped.map(function (s) {
            return '<div class="skip-row"><span>Row ' + s.row + ": " + escapeHtml(s.name || "—") + " / " + escapeHtml(s.iekNumber || "—") + '</span><span class="reason">' + escapeHtml(s.reason) + "</span></div>";
          }).join("") + "</div>";
        }
        importResult.innerHTML = html;
        importResult.hidden = false;
        pendingFile = null;
        importInput.value = "";
        importLabel.textContent = "Choose CSV or Excel file…";
        loadStats();
        loadEngineers(true);
      })
      .catch(function (err) { toast(err.message, true); })
      .finally(function () {
        importBtn.disabled = true;
        importBtn.textContent = originalLabel;
      });
  });

  // ---------- Add one engineer manually ----------
  var addForm = document.getElementById("ad-add-form");
  var addError = document.getElementById("ad-add-error");
  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    addError.hidden = true;
    var nameInput = document.getElementById("ad-add-name");
    var numberInput = document.getElementById("ad-add-number");
    var name = nameInput.value.trim();
    var iekNumber = numberInput.value.trim();
    var submitBtn = addForm.querySelector("button[type=submit]");
    var originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Adding…";
    adminApi("admin-engineers", { method: "POST", body: { name: name, iekNumber: iekNumber } })
      .then(function (d) {
        toast(d.engineer.name + " added");
        nameInput.value = "";
        numberInput.value = "";
        loadStats();
        loadEngineers(true);
      })
      .catch(function (err) {
        addError.textContent = err.message;
        addError.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  // ---------- IEK Calendar events ----------
  var eventForm = document.getElementById("ad-event-form");
  var eventError = document.getElementById("ad-event-error");
  var eventImageInput = document.getElementById("ad-event-image-input");
  var eventImageLabel = document.getElementById("ad-event-image-label");
  var eventListEl = document.getElementById("ad-event-list");
  var pendingEventImage = null;

  eventImageInput.addEventListener("change", function () {
    pendingEventImage = eventImageInput.files[0] || null;
    eventImageLabel.textContent = pendingEventImage ? pendingEventImage.name : "Add event image (optional)…";
  });

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // eventAt is a plain wall-clock string with no timezone marker — see
  // the matching comment in api/auth.js and calendar.js. Never new Date().
  function fmtEventDateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
    if (!m) return "";
    var month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]), minute = m[5];
    var ampm = hour >= 12 ? "PM" : "AM";
    var h12 = hour % 12 || 12;
    return day + " " + MONTHS[month - 1] + " " + m[1] + " · " + h12 + ":" + minute + " " + ampm;
  }

  function loadEvents() {
    adminApi("events").then(function (d) {
      eventListEl.innerHTML = d.events.length
        ? d.events
            .map(function (ev) {
              return (
                '<div class="hub-feed-item">' +
                "<div><p><strong>" + escapeHtml(ev.title) + "</strong>" + (ev.isPast ? " — past" : "") + "</p>" +
                "<time>" + escapeHtml(fmtEventDateTime(ev.eventAt)) + (ev.location ? " · " + escapeHtml(ev.location) : "") + "</time></div>" +
                '<button type="button" class="ad-edit-btn" data-delete-event="' + ev.id + '" style="margin-left:auto;">Delete</button>' +
                "</div>"
              );
            })
            .join("")
        : '<div class="hub-empty">No events posted yet.</div>';
      eventListEl.querySelectorAll("[data-delete-event]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.Hub.confirm({ message: "Members will no longer see it, and the notification about it will be removed too." }).then(function (ok) {
            if (!ok) return;
            adminApi("events", { method: "DELETE", query: { id: btn.dataset.deleteEvent } })
              .then(function () { toast("Event deleted"); loadEvents(); })
              .catch(function (err) { toast(err.message, true); });
          });
        });
      });
    });
  }

  eventForm.addEventListener("submit", function (e) {
    e.preventDefault();
    eventError.hidden = true;
    var submitBtn = eventForm.querySelector("button[type=submit]");
    var originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Posting…";

    var payload = {
      title: document.getElementById("ad-event-title").value.trim(),
      description: document.getElementById("ad-event-description").value.trim(),
      location: document.getElementById("ad-event-location").value.trim(),
      eventAt: document.getElementById("ad-event-datetime").value,
      registerUrl: document.getElementById("ad-event-register").value.trim(),
      documentUrl: document.getElementById("ad-event-document").value.trim(),
    };

    var uploadStep = pendingEventImage
      ? adminApi("upload-event-image", { method: "POST", headers: { "Content-Type": pendingEventImage.type || "image/jpeg" }, body: pendingEventImage }).then(function (d) { payload.imageUrl = d.url; })
      : Promise.resolve();

    uploadStep
      .then(function () { return adminApi("events", { method: "POST", body: payload }); })
      .then(function () {
        toast("Event posted — every member has been notified");
        eventForm.reset();
        pendingEventImage = null;
        eventImageLabel.textContent = "Add event image (optional)…";
        loadEvents();
      })
      .catch(function (err) {
        eventError.textContent = err.message;
        eventError.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  loadStats();
  loadEngineers(true);
  loadEvents();
})();
