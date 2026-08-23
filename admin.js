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

  function consentCellHtml(e) {
    var given = !!e.consentDataAt;
    var dateStr = given ? new Date(e.consentDataAt).toLocaleDateString("en-GB") : "";
    var dot =
      '<span class="ad-status-dot' + (given ? " is-online" : "") + '" title="' +
      (given ? "Data-processing consent given " + escapeHtml(dateStr) : "Data-processing consent not yet given (account still on PIN setup)") +
      '"><span class="dot"></span>' + (given ? "Consented" : "Pending") + "</span>";
    var marketing = e.consentMarketing ? '<span class="ad-consent-marketing" title="Opted in to marketing/opportunities emails">+ Marketing</span>' : "";
    return dot + marketing;
  }

  function rowHtml(e) {
    return (
      "<tr data-id=\"" + e.id + "\">" +
      "<td>" + escapeHtml(e.name) + "</td>" +
      "<td>" + escapeHtml(e.iekNumber) + "</td>" +
      '<td><span class="ad-status-dot' + (e.isActiveNow ? " is-online" : "") + '"><span class="dot"></span>' + (e.isActiveNow ? "Online" : "Offline") + "</span></td>" +
      '<td>' + consentCellHtml(e) + '</td>' +
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
        tbody.innerHTML = '<tr><td colspan="7"><div class="hub-empty">No engineers found.</div></td></tr>';
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

  var allEvents = [];
  function loadEvents() {
    adminApi("events").then(function (d) {
      allEvents = d.events;
      eventListEl.innerHTML = d.events.length
        ? d.events
            .map(function (ev) {
              return (
                '<div class="hub-feed-item">' +
                "<div><p><strong>" + escapeHtml(ev.title) + "</strong>" + (ev.isPast ? " — past" : "") + "</p>" +
                "<time>" + escapeHtml(fmtEventDateTime(ev.eventAt)) + (ev.location ? " · " + escapeHtml(ev.location) : "") + "</time></div>" +
                '<div style="margin-left:auto;display:flex;gap:14px;flex-shrink:0;">' +
                '<button type="button" class="ad-edit-btn" data-send-event-email="' + ev.id + '">Send email</button>' +
                '<button type="button" class="ad-edit-btn" data-delete-event="' + ev.id + '" style="color:var(--red-600);">Delete</button>' +
                "</div>" +
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
      eventListEl.querySelectorAll("[data-send-event-email]").forEach(function (btn) {
        btn.addEventListener("click", function () { openResendEventModal(Number(btn.dataset.sendEventEmail)); });
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

    var emailMode = document.querySelector('input[name="ad-event-recip-mode"]:checked').value;
    if (emailMode === "individual") {
      var ids = Object.keys(eventSelectedRecipientIds).map(Number);
      if (!ids.length) {
        eventError.textContent = "Select at least one engineer, or choose \"Send to all engineers with an email\".";
        eventError.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
        return;
      }
      payload.emailRecipientIds = ids;
    } else {
      payload.emailAll = true;
    }

    var uploadStep = pendingEventImage
      ? adminApi("upload-event-image", { method: "POST", headers: { "Content-Type": pendingEventImage.type || "image/jpeg" }, body: pendingEventImage }).then(function (d) { payload.imageUrl = d.url; })
      : Promise.resolve();

    uploadStep
      .then(function () { return adminApi("events", { method: "POST", body: payload }); })
      .then(function (d) {
        var sentNote = emailMode === "individual" ? "sent to " + payload.emailRecipientIds.length + " selected engineer" + (payload.emailRecipientIds.length === 1 ? "" : "s") : "emailed to everyone with an address on file";
        toast("Event posted — " + sentNote);
        eventForm.reset();
        pendingEventImage = null;
        eventImageLabel.textContent = "Add event image (optional)…";
        eventSelectedRecipientIds = {};
        document.getElementById("ad-event-recip-individual-group").hidden = true;
        document.getElementById("ad-event-recip-selected-count").textContent = "0";
        renderRecipientList("ad-event-recip-list", "ad-event-recip-selected-count", eventSelectedRecipientIds, "");
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

  // ---------- Email ----------
  var emailTabs = document.querySelectorAll("[data-emailtab]");
  var emailPanels = {
    send: document.getElementById("ad-email-send-panel"),
    templates: document.getElementById("ad-email-templates-panel"),
    logs: document.getElementById("ad-email-logs-panel"),
  };
  emailTabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      emailTabs.forEach(function (b) { b.classList.toggle("is-active", b === btn); });
      var key = btn.dataset.emailtab;
      Object.keys(emailPanels).forEach(function (k) { emailPanels[k].hidden = k !== key; });
      if (key === "logs") loadEmailLogs();
      if (key === "templates") loadTemplates();
    });
  });

  var allRecipients = [];
  function loadRecipients() {
    // Returns the promise (not "fire and forget") — openResendEventModal
    // awaits this so its picker never renders from a stale/empty
    // allRecipients if it's opened before the page's initial load call
    // has resolved.
    return adminApi("admin-email-recipients").then(function (d) {
      allRecipients = d.engineers;
      document.getElementById("ad-recip-all-count").textContent = d.marketingConsentCount;
      var discSel = document.getElementById("ad-recip-discipline");
      discSel.innerHTML = d.disciplines.map(function (x) { return '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + "</option>"; }).join("");
      var compSel = document.getElementById("ad-recip-company");
      compSel.innerHTML = d.companies.map(function (x) { return '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + "</option>"; }).join("");
      renderRecipientList("ad-recip-list", "ad-recip-selected-count", selectedRecipientIds, "");
      renderRecipientList("ad-event-recip-list", "ad-event-recip-selected-count", eventSelectedRecipientIds, "");
    });
  }

  // Shared by the Send Email form's "Choose individually" picker and the
  // IEK Calendar event form's own recipient picker — same underlying
  // engineer-with-email list, two independent selections (picking people
  // for an event email has nothing to do with whatever's mid-edit in the
  // Send Email form, and vice versa).
  var selectedRecipientIds = {};
  var eventSelectedRecipientIds = {};
  function renderRecipientList(listElId, countElId, selectedSet, q) {
    var listEl = document.getElementById(listElId);
    var filtered = q ? allRecipients.filter(function (r) { return r.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; }) : allRecipients;
    listEl.innerHTML = filtered
      .map(function (r) {
        return (
          '<label class="ad-recip-row"><input type="checkbox" value="' + r.id + '" ' + (selectedSet[r.id] ? "checked" : "") + " />" +
          escapeHtml(r.name) + (r.consentMarketing ? "" : ' <span class="ad-recip-noconsent">(not opted in)</span>') +
          '<span class="ad-recip-email">' + escapeHtml(r.email) + "</span></label>"
        );
      })
      .join("") || '<div class="hub-empty">No matches.</div>';
    listEl.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) selectedSet[cb.value] = true;
        else delete selectedSet[cb.value];
        document.getElementById(countElId).textContent = Object.keys(selectedSet).length;
      });
    });
  }
  document.getElementById("ad-recip-search").addEventListener("input", function (e) {
    renderRecipientList("ad-recip-list", "ad-recip-selected-count", selectedRecipientIds, e.target.value.trim());
  });
  document.getElementById("ad-event-recip-search").addEventListener("input", function (e) {
    renderRecipientList("ad-event-recip-list", "ad-event-recip-selected-count", eventSelectedRecipientIds, e.target.value.trim());
  });

  document.querySelectorAll('input[name="ad-recip-mode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      var mode = radio.value;
      document.getElementById("ad-recip-discipline-group").hidden = mode !== "discipline";
      document.getElementById("ad-recip-company-group").hidden = mode !== "company";
      document.getElementById("ad-recip-individual-group").hidden = mode !== "individual";
    });
  });
  document.querySelectorAll('input[name="ad-event-recip-mode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      document.getElementById("ad-event-recip-individual-group").hidden = radio.value !== "individual";
    });
  });

  // ---------- Send Email for an existing event ----------
  var resendEventOverlay = document.getElementById("ad-resend-event-overlay");
  var resendEventForm = document.getElementById("ad-resend-event-form");
  var resendEventSelectedIds = {};

  function openResendEventModal(eventId) {
    var ev = allEvents.find(function (x) { return x.id === eventId; });
    if (!ev) return;
    document.getElementById("ad-resend-event-id").value = ev.id;
    document.getElementById("ad-resend-event-for").textContent = "For: " + ev.title + " · " + fmtEventDateTime(ev.eventAt);
    // Pre-filled from the same built-in template used on auto-send, with
    // {{event_title}} already substituted — admin can still edit freely
    // before sending, per the brief ("pre-fill... admin can edit before
    // sending").
    var tpl = allTemplates.find(function (t) { return t.name === "IEK Event Invitation"; });
    document.getElementById("ad-resend-event-subject").value = tpl ? tpl.subject.replace("{{event_title}}", ev.title) : "You're invited: " + ev.title;
    document.getElementById("ad-resend-event-body").value = tpl ? tpl.body : "";
    document.querySelector('input[name="ad-resend-recip-mode"][value="all"]').checked = true;
    document.getElementById("ad-resend-recip-individual-group").hidden = true;
    resendEventSelectedIds = {};
    document.getElementById("ad-resend-recip-selected-count").textContent = "0";
    document.getElementById("ad-resend-recip-search").value = "";
    document.getElementById("ad-resend-event-error").hidden = true;
    document.getElementById("ad-resend-event-result").hidden = true;
    resendEventOverlay.hidden = false;
    // Refreshed on every open (not just rendered from whatever
    // allRecipients already happens to hold) — the initial page-load
    // call might still be in flight, and this also naturally picks up
    // anyone who added an email since the admin last loaded the page.
    loadRecipients().then(function () {
      renderRecipientList("ad-resend-recip-list", "ad-resend-recip-selected-count", resendEventSelectedIds, "");
    });
  }
  function closeResendEventModal() { resendEventOverlay.hidden = true; }
  document.getElementById("ad-resend-event-close").addEventListener("click", closeResendEventModal);
  document.getElementById("ad-resend-event-cancel").addEventListener("click", closeResendEventModal);
  resendEventOverlay.addEventListener("click", function (e) { if (e.target === resendEventOverlay) closeResendEventModal(); });
  document.getElementById("ad-resend-recip-search").addEventListener("input", function (e) {
    renderRecipientList("ad-resend-recip-list", "ad-resend-recip-selected-count", resendEventSelectedIds, e.target.value.trim());
  });
  document.querySelectorAll('input[name="ad-resend-recip-mode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      document.getElementById("ad-resend-recip-individual-group").hidden = radio.value !== "individual";
    });
  });
  resendEventForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var errBox = document.getElementById("ad-resend-event-error");
    var resultBox = document.getElementById("ad-resend-event-result");
    errBox.hidden = true;
    resultBox.hidden = true;

    var payload = {
      eventId: Number(document.getElementById("ad-resend-event-id").value),
      subject: document.getElementById("ad-resend-event-subject").value.trim(),
      body: document.getElementById("ad-resend-event-body").value.trim(),
    };
    var mode = document.querySelector('input[name="ad-resend-recip-mode"]:checked').value;
    if (mode === "individual") {
      var ids = Object.keys(resendEventSelectedIds).map(Number);
      if (!ids.length) {
        errBox.textContent = "Select at least one engineer.";
        errBox.hidden = false;
        return;
      }
      payload.emailRecipientIds = ids;
    } else {
      payload.emailAll = true;
    }

    var submitBtn = resendEventForm.querySelector("button[type=submit]");
    var originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    adminApi("admin-send-event-email", { method: "POST", body: payload })
      .then(function (d) {
        resultBox.className = "ad-import-result";
        resultBox.innerHTML = '<div class="summary">Sent to ' + d.sentCount + " engineer" + (d.sentCount === 1 ? "" : "s") + (d.failedCount ? ", " + d.failedCount + " failed" : "") + ".</div>";
        resultBox.hidden = false;
        toast("Event email sent");
        loadEmailLogs();
      })
      .catch(function (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  var allTemplates = [];
  function loadTemplates() {
    adminApi("admin-email-templates").then(function (d) {
      allTemplates = d.templates;
      var sel = document.getElementById("ad-email-template-select");
      sel.innerHTML = '<option value="">— Write from scratch —</option>' +
        d.templates.map(function (t) { return '<option value="' + t.id + '">' + escapeHtml(t.name) + (t.isBuiltin ? "" : " (custom)") + "</option>"; }).join("");

      var listEl = document.getElementById("ad-template-list");
      listEl.innerHTML = d.templates
        .map(function (t) {
          return (
            '<div class="hub-feed-item">' +
            "<div><p><strong>" + escapeHtml(t.name) + "</strong>" + (t.isBuiltin ? ' <span class="ad-recip-email">(built-in)</span>' : "") + "</p>" +
            "<time>" + escapeHtml(t.subject) + "</time></div>" +
            '<div style="margin-left:auto;display:flex;gap:10px;">' +
            '<button type="button" class="ad-edit-btn" data-use-template="' + t.id + '">Use</button>' +
            (t.isBuiltin ? "" : '<button type="button" class="ad-edit-btn" data-delete-template="' + t.id + '" style="color:var(--red-600);">Delete</button>') +
            "</div></div>"
          );
        })
        .join("") || '<div class="hub-empty">No templates yet.</div>';

      listEl.querySelectorAll("[data-use-template]").forEach(function (btn) {
        btn.addEventListener("click", function () { applyTemplateToSendForm(Number(btn.dataset.useTemplate)); switchToSendTab(); });
      });
      listEl.querySelectorAll("[data-delete-template]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.Hub.confirm({ title: "Delete template?", message: "This can't be undone." }).then(function (ok) {
            if (!ok) return;
            adminApi("admin-email-templates", { method: "DELETE", query: { id: btn.dataset.deleteTemplate } })
              .then(function () { toast("Template deleted"); loadTemplates(); })
              .catch(function (err) { toast(err.message, true); });
          });
        });
      });
    });
  }
  function switchToSendTab() {
    emailTabs.forEach(function (b) { b.classList.toggle("is-active", b.dataset.emailtab === "send"); });
    Object.keys(emailPanels).forEach(function (k) { emailPanels[k].hidden = k !== "send"; });
  }
  function applyTemplateToSendForm(id) {
    var t = allTemplates.find(function (x) { return x.id === id; });
    if (!t) return;
    document.getElementById("ad-email-template-select").value = id;
    document.getElementById("ad-email-subject").value = t.subject;
    document.getElementById("ad-email-body").value = t.body;
  }
  document.getElementById("ad-email-template-select").addEventListener("change", function (e) {
    if (e.target.value) applyTemplateToSendForm(Number(e.target.value));
  });

  document.getElementById("ad-template-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var errBox = document.getElementById("ad-template-error");
    errBox.hidden = true;
    var idVal = document.getElementById("ad-template-id").value;
    var body = {
      name: document.getElementById("ad-template-name").value.trim(),
      subject: document.getElementById("ad-template-subject").value.trim(),
      body: document.getElementById("ad-template-body").value.trim(),
    };
    if (idVal) body.id = Number(idVal);
    adminApi("admin-email-templates", { method: "POST", body: body })
      .then(function () {
        toast("Template saved");
        document.getElementById("ad-template-form").reset();
        document.getElementById("ad-template-id").value = "";
        loadTemplates();
      })
      .catch(function (err) { errBox.textContent = err.message; errBox.hidden = false; });
  });
  document.getElementById("ad-template-clear").addEventListener("click", function () {
    document.getElementById("ad-template-form").reset();
    document.getElementById("ad-template-id").value = "";
  });

  document.getElementById("ad-email-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var errBox = document.getElementById("ad-email-error");
    var resultBox = document.getElementById("ad-email-result");
    errBox.hidden = true;
    resultBox.hidden = true;

    var mode = document.querySelector('input[name="ad-recip-mode"]:checked').value;
    var payload = {
      subject: document.getElementById("ad-email-subject").value.trim(),
      body: document.getElementById("ad-email-body").value.trim(),
    };
    var templateSel = document.getElementById("ad-email-template-select");
    if (templateSel.value) {
      var t = allTemplates.find(function (x) { return x.id === Number(templateSel.value); });
      if (t) payload.templateName = t.name;
    }
    if (mode === "all") payload.all = true;
    else if (mode === "discipline") payload.filterDiscipline = document.getElementById("ad-recip-discipline").value;
    else if (mode === "company") payload.filterCompany = document.getElementById("ad-recip-company").value;
    else if (mode === "individual") {
      var ids = Object.keys(selectedRecipientIds).map(Number);
      if (!ids.length) { errBox.textContent = "Select at least one engineer."; errBox.hidden = false; return; }
      payload.recipientIds = ids;
    }

    var submitBtn = document.getElementById("ad-email-send-btn");
    var originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    adminApi("admin-send-email", { method: "POST", body: payload })
      .then(function (d) {
        resultBox.className = "ad-import-result";
        resultBox.innerHTML = '<div class="summary">Sent to ' + d.sentCount + " engineer" + (d.sentCount === 1 ? "" : "s") + (d.failedCount ? ", " + d.failedCount + " failed" : "") + ".</div>";
        resultBox.hidden = false;
        toast("Email sent");
      })
      .catch(function (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });

  function loadEmailLogs() {
    adminApi("admin-email-logs").then(function (d) {
      var body = document.getElementById("ad-log-table-body");
      body.innerHTML = d.logs.length
        ? d.logs
            .map(function (l) {
              return (
                "<tr><td>" + escapeHtml(l.subject || "—") + "</td><td>" + escapeHtml(l.templateName || "—") + "</td>" +
                "<td>" + l.recipientCount + (l.failedCount ? " (" + l.failedCount + " failed)" : "") + "</td>" +
                '<td><span class="ad-status-dot' + (l.status === "sent" ? " is-online" : "") + '"><span class="dot"></span>' + escapeHtml(l.status) + "</span></td>" +
                "<td>" + escapeHtml(timeAgo(l.sentAt)) + "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="5"><div class="hub-empty">No emails sent yet.</div></td></tr>';
    });
  }

  // ---------- Support inbox ----------
  var supportFilter = document.getElementById("ad-support-filter");
  var supportReplyOverlay = document.getElementById("ad-support-reply-overlay");
  var supportReplyForm = document.getElementById("ad-support-reply-form");

  var allThreads = [];
  function renderThreadList(threads) {
    var listEl = document.getElementById("ad-support-list");
    listEl.innerHTML = threads.length
      ? threads
          .map(function (t) {
            var last = t.messages[t.messages.length - 1];
            var preview = last ? last.body.slice(0, 90) + (last.body.length > 90 ? "…" : "") : "";
            var who = t.sender.name || t.sender.email || "Unknown sender";
            return (
              '<div class="hub-feed-item ad-thread-row" data-open-thread="' + t.id + '" style="align-items:flex-start;cursor:pointer;">' +
              "<div>" +
              "<p><strong>" + escapeHtml(t.subject) + "</strong> — " + escapeHtml(who) + (t.sender.iekNumber ? " (" + escapeHtml(t.sender.iekNumber) + ")" : "") + "</p>" +
              '<time style="display:block;margin-bottom:6px;">' + t.messages.length + " message" + (t.messages.length === 1 ? "" : "s") + " · " + escapeHtml(timeAgo(t.lastMessageAt)) + "</time>" +
              '<p style="font-size:13px;color:var(--ink-muted);margin:0;">' + escapeHtml(preview) + "</p>" +
              "</div>" +
              (t.status === "pending" ? '<span class="ad-status-dot" style="margin-left:auto;flex-shrink:0;"><span class="dot"></span>Pending</span>' : '<span class="ad-status-dot is-online" style="margin-left:auto;flex-shrink:0;"><span class="dot"></span>Replied</span>') +
              "</div>"
            );
          })
          .join("")
      : '<div class="hub-empty">No support conversations.</div>';
    listEl.querySelectorAll("[data-open-thread]").forEach(function (row) {
      row.addEventListener("click", function () { openThread(Number(row.dataset.openThread)); });
    });
  }
  function loadSupport() {
    document.getElementById("ad-support-list").innerHTML = '<div class="hub-loading">Loading…</div>';
    refreshSupportList();
  }

  function openThread(threadId) {
    var t = allThreads.find(function (x) { return x.id === threadId; });
    if (!t) return;
    document.getElementById("ad-support-reply-id").value = t.id;
    document.getElementById("ad-thread-subject").textContent = t.subject;
    document.getElementById("ad-thread-sender").textContent =
      (t.sender.name || t.sender.email || "Unknown sender") + (t.sender.email ? " · " + t.sender.email : "");
    document.getElementById("ad-thread-messages").innerHTML = t.messages
      .map(function (m) {
        return (
          '<div class="ad-thread-msg is-' + m.senderType + (m.source === "inbound_email" ? " is-inbound" : "") + '">' +
          escapeHtml(m.body) +
          '<span class="ad-thread-msg-meta">' + (m.senderType === "admin" ? "You" : escapeHtml(m.senderName || "them")) + " · " + escapeHtml(timeAgo(m.createdAt)) + "</span>" +
          "</div>"
        );
      })
      .join("");
    document.getElementById("ad-thread-messages").scrollTop = document.getElementById("ad-thread-messages").scrollHeight;
    document.getElementById("ad-support-reply-text").value = "";
    document.getElementById("ad-support-reply-error").hidden = true;
    supportReplyOverlay.hidden = false;
    document.getElementById("ad-support-reply-text").focus();
  }

  supportFilter.addEventListener("change", loadSupport);
  document.getElementById("ad-support-reply-close").addEventListener("click", function () { supportReplyOverlay.hidden = true; });
  document.getElementById("ad-support-reply-cancel").addEventListener("click", function () { supportReplyOverlay.hidden = true; });
  supportReplyOverlay.addEventListener("click", function (e) { if (e.target === supportReplyOverlay) supportReplyOverlay.hidden = true; });
  supportReplyForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var errBox = document.getElementById("ad-support-reply-error");
    errBox.hidden = true;
    var id = Number(document.getElementById("ad-support-reply-id").value);
    var reply = document.getElementById("ad-support-reply-text").value.trim();
    var submitBtn = supportReplyForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    adminApi("admin-support-reply", { method: "POST", body: { id: id, reply: reply } })
      .then(function () {
        toast("Reply sent");
        return refreshSupportList();
      })
      .then(function (d) {
        // Re-open the same conversation with the refreshed data so the
        // admin sees their own reply appended in place, rather than the
        // modal just closing on them mid-conversation. If the reply
        // filter (e.g. "Pending only") now excludes this thread, close
        // instead of showing a stale/hidden one.
        if (d.threads.some(function (t) { return t.id === id; })) openThread(id);
        else supportReplyOverlay.hidden = true;
      })
      .catch(function (err) { errBox.textContent = err.message; errBox.hidden = false; })
      .finally(function () { submitBtn.disabled = false; });
  });
  function refreshSupportList() {
    return adminApi("admin-support", { query: { status: supportFilter.value } }).then(function (d) {
      allThreads = d.threads;
      renderThreadList(d.threads);
      return d;
    });
  }

  loadStats();
  loadEngineers(true);
  loadEvents();
  loadRecipients();
  loadTemplates();
  loadSupport();
})();
