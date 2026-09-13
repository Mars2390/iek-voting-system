(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var V = window.HubVote;

  var params = new URLSearchParams(window.location.search);
  var campaignId = Number(params.get("id"));
  var loadingEl = document.getElementById("cp-loading");
  var contentEl = document.getElementById("cp-content");
  var heroEl = document.getElementById("cp-hero");
  var manifestoEl = document.getElementById("cp-manifesto");
  var ownerEl = document.getElementById("cp-owner");

  if (!campaignId) {
    loadingEl.textContent = "That campaign link is missing its id.";
    return;
  }

  var me = null;
  var campaign = null;
  var election = null;
  var myVoteCampaignId = null;
  var totalEngineers = 0;
  var elections = [];
  var pollTimer = null;

  // ---------- Load ----------
  function load() {
    return H.api("campaigns", { query: { id: campaignId } }).then(function (data) {
      V.syncClock(data.serverTime);
      campaign = data.campaign;
      election = data.election;
      myVoteCampaignId = data.myVoteCampaignId;
      totalEngineers = data.totalEngineers;
      document.title = campaign.candidateName + " for " + campaign.position + " — Engineer Hub";
    });
  }

  // ---------- Hero ----------
  function renderHero() {
    var c = campaign;
    var windowText = c.electionId
      ? (election ? V.windowLine(election) : "")
      : V.windowLine({ phase: c.phase === "ended" ? "closed" : c.phase, startsAt: c.startsAt, endsAt: c.endsAt });
    heroEl.innerHTML =
      '<div>' + V.photoHtml(c, "hero") + "</div>" +
      '<div class="vt-hero-body">' +
      '<div class="vt-hero-meta">' + V.phasePill(c.phase) + " " + V.verifiedBadge(c) +
      (c.electionTitle ? '<a href="/elections.html?election=' + c.electionId + '" style="color:var(--red-600);text-decoration:none;font-weight:700;">' + H.escapeHtml(c.electionTitle) + "</a>" : "<span>Independent campaign</span>") +
      "</div>" +
      "<h1>" + H.escapeHtml(c.candidateName) + "</h1>" +
      '<div class="vt-hero-campaign">' + H.escapeHtml(c.name) + "</div>" +
      '<div class="vt-hero-meta"><span>Running for <strong style="color:var(--ink);">' + H.escapeHtml(c.position) + "</strong></span>" +
      (c.creatorTitle || c.creatorCompany ? "<span>" + H.escapeHtml([c.creatorTitle, c.creatorCompany].filter(Boolean).join(" at ")) + "</span>" : "") +
      (c.creatorDiscipline ? "<span>" + H.escapeHtml(c.creatorDiscipline) + "</span>" : "") +
      '<a href="/profile.html?id=' + c.creatorId + '" style="color:var(--red-600);text-decoration:none;font-weight:700;">View profile</a>' +
      "</div>" +
      (windowText ? '<div class="vt-hero-window" id="cp-window">' + H.escapeHtml(windowText) + "</div>" : "") +
      '<div class="vt-hero-votes"><strong id="cp-votes">' + c.votes + "</strong><span>vote" + (c.votes === 1 ? "" : "s") + " so far · " + Math.round((c.votes / Math.max(totalEngineers, 1)) * 1000) / 10 + "% of " + totalEngineers + " engineers</span></div>" +
      '<div class="vt-hero-actions">' + V.voteButtonHtml(c, myVoteCampaignId) + "</div>" +
      '<div class="vt-share-row">' +
      '<button type="button" class="eh-btn eh-btn-ghost-light hub-btn-sm" id="cp-copy-btn">Copy campaign link</button>' +
      '<a class="eh-btn eh-btn-ghost-light hub-btn-sm" id="cp-wa-btn" href="' + H.escapeHtml(V.whatsappShareUrl(c)) + '" target="_blank" rel="noopener">Share on WhatsApp</a>' +
      "</div></div>";
    V.wireVoteButtons(heroEl, function () { return campaign; }, function () { refresh(); });
    document.getElementById("cp-copy-btn").addEventListener("click", function () {
      V.copyText(V.campaignUrl(c.id)).then(function () { H.toast("Link copied — share it anywhere"); }).catch(function () { H.toast("Couldn't copy. The link is: " + V.campaignUrl(c.id), true); });
    });

    var bio = c.bio ? H.escapeHtml(c.bio) : '<span class="vt-muted">This candidate hasn\'t written a manifesto yet.</span>';
    manifestoEl.innerHTML = "<h2>Manifesto</h2><p>" + bio + "</p>";
  }

  // ---------- Owner tools ----------
  var ownerInited = false;
  function renderOwner() {
    var c = campaign;
    ownerEl.hidden = !c.isOwner;
    if (!c.isOwner) return;
    var note = document.getElementById("cp-owner-note");
    var lines = [];
    if (c.status === "withdrawn") lines.push("This campaign has been withdrawn and is no longer on the ballot.");
    else if (c.electionId && !c.verified) lines.push("Your candidacy is awaiting verification by the election admin. Until then, engineers can read your manifesto but can't vote for you or receive your SMS.");
    else if (c.phase === "upcoming") lines.push("Voting hasn't opened yet. Use this time to share your link and send SMS to fellow engineers.");
    else if (c.phase === "live") lines.push("Voting is open. " + c.votes + " engineer" + (c.votes === 1 ? " has" : "s have") + " voted for you so far.");
    else lines.push("Voting has ended. Final count: " + c.votes + " vote" + (c.votes === 1 ? "" : "s") + ".");
    note.textContent = lines.join(" ");
    note.className = "vt-owner-note" + (c.electionId && !c.verified ? " is-warn" : "");
    document.getElementById("cp-delete-btn").hidden = c.votes > 0;
    document.getElementById("cp-withdraw-btn").hidden = !(c.votes > 0 && c.status !== "withdrawn" && c.phase !== "ended");
    if (!ownerInited) { ownerInited = true; initOwner(); }
    refreshSmsQuota();
  }

  function initOwner() {
    document.querySelectorAll(".hub-tab[data-otab]").forEach(function (t) {
      t.addEventListener("click", function () { switchOwnerTab(t.dataset.otab); });
    });
    document.getElementById("cp-edit-btn").addEventListener("click", function () {
      V.openCampaignForm({ campaign: campaign, elections: elections, me: me, onSaved: function () { refresh(); } });
    });
    document.getElementById("cp-sms-jump-btn").addEventListener("click", function () { switchOwnerTab("sms"); });
    document.getElementById("cp-delete-btn").addEventListener("click", function () {
      H.confirm({ title: "Delete this campaign?", message: "It will be removed for everyone. This can't be undone." }).then(function (ok) {
        if (!ok) return;
        H.api("campaigns", { method: "DELETE", query: { id: campaign.id } })
          .then(function () { H.toast("Campaign deleted"); window.location.href = "/elections.html?tab=mine"; })
          .catch(function (err) { H.toast(err.message, true); });
      });
    });
    document.getElementById("cp-withdraw-btn").addEventListener("click", function () {
      H.confirm({ title: "Withdraw from the race?", message: "Your campaign comes off the ballot and out of the results. Votes already cast stay on record. This can't be undone.", confirmText: "Withdraw" }).then(function (ok) {
        if (!ok) return;
        H.api("campaigns", { method: "DELETE", query: { id: campaign.id, withdraw: "1" } })
          .then(function () { H.toast("Campaign withdrawn"); refresh(); })
          .catch(function (err) { H.toast(err.message, true); });
      });
    });
    initSms();
  }

  function switchOwnerTab(tab) {
    document.querySelectorAll(".hub-tab[data-otab]").forEach(function (t) { t.classList.toggle("is-active", t.dataset.otab === tab); });
    document.getElementById("cp-owner-overview").hidden = tab !== "overview";
    document.getElementById("cp-owner-sms").hidden = tab !== "sms";
    document.getElementById("cp-owner-tracking").hidden = tab !== "tracking";
    if (tab === "sms") { loadRecipients(); loadBatches(); }
    if (tab === "tracking") loadTracking();
    ownerEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- SMS tool ----------
  var recipients = [];
  var recipientsLoaded = false;
  var selectedIds = {};
  var sending = false;
  var smsMeta = { remainingToday: null, dailyLimit: 3, maxChars: 300, smsConfigured: true };
  var textEl, counterEl, previewEl, signatureEl, sendBtn, testBtn, errorEl, quotaEl, progressEl, progressFill, progressLabel, whenAt;

  function initSms() {
    textEl = document.getElementById("cp-sms-text");
    counterEl = document.getElementById("cp-sms-counter");
    previewEl = document.getElementById("cp-sms-preview");
    signatureEl = document.getElementById("cp-sms-signature");
    sendBtn = document.getElementById("cp-sms-send");
    testBtn = document.getElementById("cp-sms-test");
    errorEl = document.getElementById("cp-sms-error");
    quotaEl = document.getElementById("cp-sms-quota");
    progressEl = document.getElementById("cp-sms-progress");
    progressFill = document.getElementById("cp-sms-progress-fill");
    progressLabel = document.getElementById("cp-sms-progress-label");
    whenAt = document.getElementById("cp-sms-when-at");

    textEl.addEventListener("input", updatePreview);
    signatureEl.addEventListener("change", updatePreview);
    updatePreview();

    document.querySelectorAll('input[name="cp-mode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        document.getElementById("cp-discipline-wrap").hidden = r.value !== "discipline";
        document.getElementById("cp-individual-wrap").hidden = r.value !== "individual";
      });
    });
    document.querySelectorAll('input[name="cp-when"]').forEach(function (r) {
      r.addEventListener("change", function () {
        whenAt.disabled = r.value !== "later";
        if (r.value === "later" && !whenAt.value) {
          var d = new Date(Date.now() + 3600000);
          var pad = function (n) { return String(n).padStart(2, "0"); };
          whenAt.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
        }
      });
    });
    document.getElementById("cp-recip-search").addEventListener("input", renderRecipientList);
    document.getElementById("cp-sms-form").addEventListener("submit", function (e) { e.preventDefault(); sendSms(false); });
    testBtn.addEventListener("click", function () { sendSms(true); });
  }

  function signatureText() {
    return "\n- " + campaign.candidateName + ", " + campaign.position + ". " + V.campaignUrl(campaign.id);
  }
  function updatePreview() {
    var text = textEl.value;
    var sig = signatureEl.checked ? signatureText() : "";
    var sample = (text || "…").replace(/\[Name\]/gi, me && me.displayName ? me.displayName : "Engineer") + sig;
    previewEl.textContent = sample;
    var total = sample.length;
    var parts = total <= 160 ? 1 : Math.ceil(total / 153);
    counterEl.innerHTML = text.length + " / " + smsMeta.maxChars + ' · <span class="' + (parts > 2 ? "over" : "") + '">' + total + " characters with signature = " + parts + " SMS part" + (parts === 1 ? "" : "s") + "</span>";
  }

  function refreshSmsQuota() {
    if (!campaign.isOwner) return;
    H.api("campaign-sms", { query: { campaignId: campaign.id } }).then(function (d) {
      smsMeta = d;
      quotaEl.textContent = d.remainingToday + " of " + d.dailyLimit + " sends left today";
      var blocked = document.getElementById("cp-sms-blocked");
      var reason = !d.smsConfigured ? "SMS isn't configured on the server yet — ask the admin to set the Sozuri credentials."
        : campaign.status === "withdrawn" || campaign.phase === "ended" ? "This campaign is no longer running, so SMS sending is closed."
        : campaign.electionId && !campaign.verified ? "Your candidacy has to be verified by the election admin before you can send SMS."
        : d.remainingToday === 0 ? "You've used all " + d.dailyLimit + " SMS sends for this campaign in the last 24 hours. Try again later." : "";
      blocked.textContent = reason;
      blocked.hidden = !reason;
      // The 8-second page poll lands here too — never re-enable the
      // buttons underneath a send that's still driving the dispatcher.
      if (!sending) {
        sendBtn.disabled = !!reason;
        testBtn.disabled = !!reason;
      }
      renderBatches(d.batches);
    }).catch(function () {});
  }

  function loadRecipients() {
    if (recipientsLoaded) return;
    H.api("campaign-sms-recipients", { query: { campaignId: campaign.id } }).then(function (d) {
      recipientsLoaded = true;
      recipients = d.engineers;
      document.getElementById("cp-count-all").textContent = d.counts.withPhone;
      document.getElementById("cp-count-notvoted").textContent = d.counts.notVoted;
      var sel = document.getElementById("cp-discipline");
      sel.innerHTML = d.disciplines.length
        ? d.disciplines.map(function (x) { return "<option>" + H.escapeHtml(x) + "</option>"; }).join("")
        : '<option value="">No disciplines on file yet</option>';
      renderRecipientList();
    }).catch(function (err) { H.toast(err.message, true); });
  }

  function renderRecipientList() {
    var q = document.getElementById("cp-recip-search").value.trim().toLowerCase();
    var list = document.getElementById("cp-recip-list");
    var rows = recipients.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 400);
    list.innerHTML = rows.map(function (e) {
      return '<label class="vt-recip-row' + (e.hasPhone ? "" : " is-disabled") + '"><input type="checkbox" data-rid="' + e.id + '"' + (selectedIds[e.id] ? " checked" : "") + (e.hasPhone ? "" : " disabled") + " />" +
        H.escapeHtml(e.name) + (e.hasPhone ? "" : ' <small class="vt-muted">(no phone)</small>') + (e.hasVoted ? '<span class="tag">Voted</span>' : "") + "</label>";
    }).join("") || '<div class="vt-muted" style="padding:10px;">No one matches.</div>';
    list.querySelectorAll("input[data-rid]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) selectedIds[cb.dataset.rid] = true; else delete selectedIds[cb.dataset.rid];
        document.getElementById("cp-selected-count").textContent = Object.keys(selectedIds).length;
      });
    });
  }

  function sendSms(isTest) {
    if (sending) return;
    errorEl.hidden = true;
    var mode = document.querySelector('input[name="cp-mode"]:checked').value;
    var body = { campaignId: campaign.id, message: textEl.value, includeSignature: signatureEl.checked };
    if (isTest) {
      body.mode = "individual";
      body.engineerIds = [me.id];
    } else {
      body.mode = mode;
      if (mode === "discipline") body.discipline = document.getElementById("cp-discipline").value;
      if (mode === "individual") body.engineerIds = Object.keys(selectedIds).map(Number);
      if (document.querySelector('input[name="cp-when"]:checked').value === "later") {
        if (!whenAt.value) { errorEl.textContent = "Pick a date and time to schedule the send."; errorEl.hidden = false; return; }
        body.scheduledFor = new Date(whenAt.value).toISOString();
      }
    }
    if (!body.message.trim()) { errorEl.textContent = "Write your message first."; errorEl.hidden = false; textEl.focus(); return; }

    var confirmMsg = isTest
      ? "Send this message to your own phone as a test? It counts as one of your " + smsMeta.dailyLimit + " daily sends."
      : body.scheduledFor
      ? "Schedule this SMS to go out at " + V.fmtDateTime(body.scheduledFor) + "?"
      : "Send this SMS now to " + (mode === "individual" ? Object.keys(selectedIds).length + " selected engineer(s)" : mode === "not_voted" ? "every engineer who hasn't voted yet" : mode === "discipline" ? "every engineer in " + document.getElementById("cp-discipline").value : "every engineer with a phone number") + "?";
    H.confirm({ title: isTest ? "Send test SMS" : body.scheduledFor ? "Schedule SMS" : "Send SMS", message: confirmMsg, confirmText: isTest ? "Send test" : body.scheduledFor ? "Schedule" : "Send now", danger: false }).then(function (ok) {
      if (!ok) return;
      sending = true;
      sendBtn.disabled = true; testBtn.disabled = true;
      sendBtn.textContent = "Working…";
      H.api("campaign-sms", { method: "POST", body: body })
        .then(function (d) {
          if (!d.batch.immediate) {
            H.toast("Scheduled for " + V.fmtDateTime(d.batch.scheduledFor));
            finishSend();
            return;
          }
          progressEl.hidden = false;
          progressFill.style.width = "0%";
          progressLabel.textContent = "Sending 0 / " + d.batch.recipientsCount + "…";
          return drive(d.batch.id, d.batch.recipientsCount);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          finishSend();
        });
    });
  }

  // Drives the server-side dispatcher until this batch is drained,
  // updating the progress bar from each chunk's result.
  function drive(batchId, total) {
    return H.api("campaign-sms-dispatch", { method: "POST" }).then(function (d) {
      if (d.batchId === batchId || d.batchId === null) {
        var done = d.batchId === null ? total : total - d.remaining;
        progressFill.style.width = Math.round((done / Math.max(total, 1)) * 100) + "%";
        progressLabel.textContent = d.batchId === null || d.done
          ? "Finished: " + (d.sent || 0) + " sent, " + (d.failed || 0) + " failed, " + (d.invalid || 0) + " without a usable number."
          : "Sending " + done + " / " + total + "…";
        if (d.batchId !== null && !d.done) return drive(batchId, total);
      } else {
        // Another campaign's batch was ahead of ours in the queue — keep going.
        progressLabel.textContent = "Waiting for the sending queue…";
        return drive(batchId, total);
      }
      H.toast("SMS send complete");
      finishSend();
      textEl.value = "";
      updatePreview();
    }).catch(function (err) {
      progressLabel.textContent = "Interrupted: " + err.message + " — the remaining messages continue in the background.";
      finishSend();
    });
  }

  function finishSend() {
    sending = false;
    sendBtn.textContent = "Send SMS";
    refreshSmsQuota();
    recipientsLoaded = false;
    loadRecipients();
  }

  function loadBatches() { refreshSmsQuota(); }
  function renderBatches(batches) {
    var el = document.getElementById("cp-batches");
    if (!batches || !batches.length) { el.innerHTML = '<div class="vt-muted" style="font-size:14px;">Nothing sent yet.</div>'; return; }
    var modeLabel = { all: "All engineers", not_voted: "Not yet voted", discipline: "Discipline", individual: "Selected engineers" };
    el.innerHTML = batches.map(function (b) {
      var status = b.status === "scheduled" ? "Scheduled for " + V.fmtDateTime(b.scheduledFor) : b.status === "sending" ? "Sending… " + (b.recipientsCount - b.openCount) + "/" + b.recipientsCount : b.status === "cancelled" ? "Cancelled" : "Sent " + V.fmtDateTime(b.completedAt || b.createdAt);
      return '<div class="vt-batch"><div class="vt-batch-main"><div class="vt-batch-msg">' + H.escapeHtml(b.message.split("\n")[0]) + "</div>" +
        '<div class="vt-batch-meta">' + status + " · " + (modeLabel[b.recipientMode] || b.recipientMode) + (b.recipientFilter ? ": " + H.escapeHtml(b.recipientFilter) : "") + " · " + b.recipientsCount + " recipient" + (b.recipientsCount === 1 ? "" : "s") + "</div></div>" +
        (b.status === "done" || b.status === "sending" ? '<div class="vt-batch-stats"><span class="sent">' + b.sentCount + " sent</span>" + (b.failedCount ? '<span class="failed">' + b.failedCount + " failed</span>" : "") + (b.invalidCount ? '<span class="invalid">' + b.invalidCount + " no number</span>" : "") + "</div>" : "") +
        '<div class="vt-batch-actions">' +
        (b.status === "scheduled" ? '<button type="button" class="eh-btn eh-btn-ghost-light hub-btn-sm" data-cancel="' + b.id + '">Cancel</button>' : "") +
        (b.status !== "cancelled" ? '<button type="button" class="eh-btn eh-btn-ghost-light hub-btn-sm" data-track="' + b.id + '">Tracking</button>' : "") +
        "</div></div>";
    }).join("");
    el.querySelectorAll("[data-cancel]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        H.confirm({ title: "Cancel this scheduled SMS?", message: "It won't be sent.", confirmText: "Cancel send" }).then(function (ok) {
          if (!ok) return;
          H.api("campaign-sms", { method: "DELETE", query: { id: btn.dataset.cancel } }).then(function () { H.toast("Cancelled"); refreshSmsQuota(); }).catch(function (err) { H.toast(err.message, true); });
        });
      });
    });
    el.querySelectorAll("[data-track]").forEach(function (btn) {
      btn.addEventListener("click", function () { switchOwnerTab("tracking"); loadTracking(Number(btn.dataset.track)); });
    });
  }

  // ---------- Tracking ----------
  function loadTracking(batchId) {
    var el = document.getElementById("cp-tracking");
    el.innerHTML = '<div class="hub-loading" style="padding:20px;">Loading…</div>';
    H.api("campaign-sms", { query: { campaignId: campaign.id } }).then(function (d) {
      var batches = d.batches.filter(function (b) { return b.status !== "cancelled"; });
      if (!batches.length) { el.innerHTML = '<div class="vt-muted">No SMS sent yet — send one from the SMS outreach tab and tracking appears here.</div>'; return; }
      var chosen = batchId || batches[0].id;
      el.innerHTML = '<div class="vt-toolbar"><select id="cp-track-select">' +
        batches.map(function (b) { return '<option value="' + b.id + '"' + (b.id === chosen ? " selected" : "") + ">" + H.escapeHtml(V.fmtDateTime(b.createdAt)) + " — " + H.escapeHtml(b.message.split("\n")[0].slice(0, 60)) + "</option>"; }).join("") +
        '</select></div><div id="cp-track-body"></div>';
      document.getElementById("cp-track-select").addEventListener("change", function (e) { renderTracking(Number(e.target.value)); });
      renderTracking(chosen);
    }).catch(function (err) { el.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; });
  }
  function renderTracking(batchId) {
    var body = document.getElementById("cp-track-body");
    body.innerHTML = '<div class="hub-loading" style="padding:20px;">Loading…</div>';
    H.api("campaign-sms-batch", { query: { id: batchId } }).then(function (d) {
      var rs = d.recipients;
      var sent = rs.filter(function (r) { return r.status === "sent"; }).length;
      var voted = rs.filter(function (r) { return r.hasVoted; }).length;
      var votedAfterSms = rs.filter(function (r) { return r.status === "sent" && r.hasVoted; }).length;
      var statusText = { sent: "Sent", failed: "Failed", invalid_phone: "No usable number", pending: "Queued", sending: "Sending" };
      body.innerHTML =
        '<div class="vt-track-summary"><span>' + rs.length + " recipients</span><span style=\"color:var(--green-600);\">" + sent + " received</span><span>" + voted + " have voted</span><span>" + votedAfterSms + " received &amp; voted</span></div>" +
        '<div class="vt-track-wrap"><table class="vt-track-table"><thead><tr><th>Engineer</th><th>SMS</th><th>Delivery</th><th>Voted</th></tr></thead><tbody>' +
        rs.map(function (r) {
          return "<tr><td>" + H.escapeHtml(r.name) + '</td><td class="st-' + r.status + '">' + (statusText[r.status] || r.status) + (r.error ? ' <small class="vt-muted">' + H.escapeHtml(r.error) + "</small>" : "") + "</td>" +
            "<td>" + H.escapeHtml(r.providerStatus || "—") + "</td>" +
            "<td>" + (r.hasVoted ? '<span style="color:var(--green-600);font-weight:800;">&#10003; Voted</span>' : '<span class="vt-muted">Not yet</span>') + "</td></tr>";
        }).join("") +
        "</tbody></table></div>";
    }).catch(function (err) { body.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; });
  }

  // ---------- Live refresh ----------
  var refreshing = false;
  function refresh() {
    if (refreshing || V.isBusy() || document.querySelector(".hub-modal-overlay")) return;
    refreshing = true;
    load().then(function () { renderHero(); renderOwner(); }).catch(function () {}).finally(function () { refreshing = false; });
  }

  Promise.all([H.api("me"), H.api("elections")])
    .then(function (r) { me = r[0].engineer; elections = r[1].elections; return load(); })
    .then(function () {
      loadingEl.hidden = true;
      contentEl.hidden = false;
      renderHero();
      renderOwner();
      pollTimer = setInterval(function () { if (document.visibilityState === "visible") refresh(); }, 8000);
      if (params.get("tab") === "sms" && campaign.isOwner) switchOwnerTab("sms");
      V.pokeDispatcher(3);
    })
    .catch(function (err) {
      loadingEl.textContent = err.message === "Campaign not found." ? "This campaign doesn't exist (it may have been deleted)." : err.message || "Couldn't load this campaign.";
    });
})();
