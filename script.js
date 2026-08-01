/* =========================================================
   IEK Online Voting System — Application Logic
   Data persistence: Neon PostgreSQL via Vercel Functions (/api/*)
   Real-time-ish: polls the API every 5s so every device converges
   on the same data without a manual refresh (see README for why
   polling was chosen over WebSockets).
   ========================================================= */

(function () {
  "use strict";

  const POLL_INTERVAL_MS = 5000;
  const COUNTDOWN_TICK_MS = 1000;
  const MAX_NOTIFICATIONS = 40;
  const IDENTITY_KEY = "iek_caller_name";

  const CONTACT_STATUS_LABELS = {
    pending: "Pending",
    confirmed: "Called & Confirmed",
    no_answer: "Called - No Answer",
    busy_declined: "Called - Busy/Declined",
    follow_up: "Follow-up Needed",
    not_reachable: "Not Reachable",
  };
  const CONTACT_STATUS_ICONS = {
    pending: "📝",
    confirmed: "✅",
    no_answer: "📞",
    busy_declined: "📱",
    follow_up: "🔄",
    not_reachable: "❌",
  };

  let engineers = [];
  let engineersById = new Map();
  let candidates = [];
  let candidatesById = new Map();
  let hasLoadedOnce = false;
  let activeFilter = "all"; // all | voted | not-voted
  let activeContactFilter = ""; // "" | pending | confirmed | no_answer | busy_declined | follow_up | not_reachable
  let activeExportFormat = "csv"; // csv | excel
  let isBusy = false;
  let selectedIds = new Set();

  let electionStatus = null; // { phase, startsAt, endsAt, serverTime, testMode }
  let notifications = [];
  let unseenCount = 0;

  let pollTimer = null;
  let countdownTimer = null;
  let callModalStatus = null;

  // ---------- DOM references ----------
  const el = {
    tableBody: document.getElementById("tableBody"),
    emptyState: document.getElementById("emptyState"),
    resultsCount: document.getElementById("resultsCount"),
    searchInput: document.getElementById("searchInput"),
    filterBtns: document.querySelectorAll(".filter-btn"),
    toggleFormBtn: document.getElementById("toggleFormBtn"),
    cancelFormBtn: document.getElementById("cancelFormBtn"),
    formPanel: document.getElementById("formPanel"),
    formTitle: document.getElementById("formTitle"),
    formSubmitBtn: document.getElementById("formSubmitBtn"),
    engineerForm: document.getElementById("engineerForm"),
    engineerId: document.getElementById("engineerId"),
    importCsvBtn: document.getElementById("importCsvBtn"),
    importCsvInput: document.getElementById("importCsvInput"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    exportDropdown: document.getElementById("exportDropdown"),
    fullReportPdfBtn: document.getElementById("fullReportPdfBtn"),
    printBtn: document.getElementById("printBtn"),
    resetVotesBtn: document.getElementById("resetVotesBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    lastUpdated: document.getElementById("lastUpdated"),
    lastActivity: document.getElementById("lastActivity"),
    toast: document.getElementById("toast"),
    statTotal: document.getElementById("statTotal"),
    statVoted: document.getElementById("statVoted"),
    statNotVoted: document.getElementById("statNotVoted"),
    statTurnout: document.getElementById("statTurnout"),
    statFollowUp: document.getElementById("statFollowUp"),
    turnoutBarFill: document.getElementById("turnoutBarFill"),
    contactFilter: document.getElementById("contactFilter"),
    connectionBanner: document.getElementById("connectionBanner"),
    connectionBannerText: document.getElementById("connectionBannerText"),
    retryConnectionBtn: document.getElementById("retryConnectionBtn"),
    clock: document.getElementById("clock"),
    year: document.getElementById("year"),
    notificationBell: document.getElementById("notificationBell"),
    bellBadge: document.getElementById("bellBadge"),
    notificationDropdown: document.getElementById("notificationDropdown"),
    notificationList: document.getElementById("notificationList"),
    countdownBanner: document.getElementById("countdownBanner"),
    countdownPhaseLabel: document.getElementById("countdownPhaseLabel"),
    countdownClock: document.getElementById("countdownClock"),
    countdownSub: document.getElementById("countdownSub"),
    auditLogBtn: document.getElementById("auditLogBtn"),
    auditPanel: document.getElementById("auditPanel"),
    closeAuditBtn: document.getElementById("closeAuditBtn"),
    auditTableBody: document.getElementById("auditTableBody"),
    toggleCandidateFormBtn: document.getElementById("toggleCandidateFormBtn"),
    cancelCandidateFormBtn: document.getElementById("cancelCandidateFormBtn"),
    candidateForm: document.getElementById("candidateForm"),
    candidatesGrid: document.getElementById("candidatesGrid"),
    candidatesEmpty: document.getElementById("candidatesEmpty"),
    identityBadge: document.getElementById("identityBadge"),
    identityName: document.getElementById("identityName"),
    quickNavBtns: document.querySelectorAll(".quick-nav-btn"),
    urgentNavBadge: document.getElementById("urgentNavBadge"),
    selectAllCheckbox: document.getElementById("selectAllCheckbox"),
    bulkBar: document.getElementById("bulkBar"),
    bulkCount: document.getElementById("bulkCount"),
    bulkStatusSelect: document.getElementById("bulkStatusSelect"),
    bulkApplyBtn: document.getElementById("bulkApplyBtn"),
    bulkExportBtn: document.getElementById("bulkExportBtn"),
    bulkPrintBtn: document.getElementById("bulkPrintBtn"),
    bulkClearBtn: document.getElementById("bulkClearBtn"),
    urgentTableBody: document.getElementById("urgentTableBody"),
    urgentEmpty: document.getElementById("urgentEmpty"),
    urgentCount: document.getElementById("urgentCount"),
    agendaTableBody: document.getElementById("agendaTableBody"),
    agendaEmpty: document.getElementById("agendaEmpty"),
    agendaCount: document.getElementById("agendaCount"),
    anaTotal: document.getElementById("anaTotal"),
    anaConfirmed: document.getElementById("anaConfirmed"),
    anaNoAnswer: document.getElementById("anaNoAnswer"),
    anaFollowUp: document.getElementById("anaFollowUp"),
    anaNotReachable: document.getElementById("anaNotReachable"),
    anaPending: document.getElementById("anaPending"),
    anaTurnout: document.getElementById("anaTurnout"),
    pieChart: document.getElementById("pieChart"),
    pieChartLegend: document.getElementById("pieChartLegend"),
    barChart: document.getElementById("barChart"),
    lineChart: document.getElementById("lineChart"),
    callModalOverlay: document.getElementById("callModalOverlay"),
    callModalName: document.getElementById("callModalName"),
    callModalPhone: document.getElementById("callModalPhone"),
    callEngineerId: document.getElementById("callEngineerId"),
    callForm: document.getElementById("callForm"),
    callNotes: document.getElementById("callNotes"),
    callSubmitBtn: document.getElementById("callSubmitBtn"),
    callCancelBtn: document.getElementById("callCancelBtn"),
    callModalClose: document.getElementById("callModalClose"),
    detailsModalOverlay: document.getElementById("detailsModalOverlay"),
    detailsModalName: document.getElementById("detailsModalName"),
    detailsModalBody: document.getElementById("detailsModalBody"),
    detailsModalClose: document.getElementById("detailsModalClose"),
  };

  // ---------- Utilities ----------
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function initials(name) {
    return String(name || "?")
      .replace(/^Eng\.?\s*/i, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("") || "?";
  }

  function formatDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    return d.toLocaleString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).replace(",", "");
  }

  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle("error", !!isError);
    el.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("show"), 2800);
  }

  function showConnectionError(message) {
    el.connectionBannerText.textContent = message;
    el.connectionBanner.hidden = false;
  }

  function hideConnectionError() {
    el.connectionBanner.hidden = true;
  }

  function setBusy(busy) {
    isBusy = busy;
    document.body.classList.toggle("is-busy", busy);
  }

  function markActivity() {
    el.lastActivity.textContent = `Last activity: ${new Date().toLocaleTimeString()}`;
  }

  // ---------- Identity (self-reported, NOT authentication) ----------
  // There is no login system in this app. This is just a per-browser label
  // so call logs / remarks show a human name instead of "anonymous" — it is
  // not verified and can't be trusted the way a real logged-in user would be.
  function getIdentity() {
    return (localStorage.getItem(IDENTITY_KEY) || "").trim();
  }

  function setIdentity(name) {
    localStorage.setItem(IDENTITY_KEY, name.trim());
    renderIdentityBadge();
  }

  function renderIdentityBadge() {
    const name = getIdentity();
    el.identityName.textContent = name || "Set your name";
  }

  function ensureIdentity() {
    let name = getIdentity();
    if (!name) {
      name = (prompt("Your name (shown on every call log / remark you add):") || "").trim();
      if (name) setIdentity(name);
    }
    return name;
  }

  // ---------- API layer ----------
  async function apiFetch(url, options) {
    let response;
    try {
      response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
    } catch (networkErr) {
      throw new Error("Network error — could not reach the server. Check your internet connection.");
    }

    let body = null;
    try {
      body = await response.json();
    } catch (parseErr) {
      // no JSON body — fine for some responses
    }

    if (!response.ok) {
      const message = (body && body.error) || `Request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return body;
  }

  async function fetchEngineers() {
    const data = await apiFetch("/api/engineers");
    return data.engineers;
  }

  async function fetchStats() {
    return apiFetch("/api/stats");
  }

  async function fetchElectionStatus() {
    return apiFetch("/api/election-status");
  }

  async function fetchCandidates() {
    const data = await apiFetch("/api/candidates");
    return data.candidates;
  }

  async function fetchUrgent() {
    const data = await apiFetch("/api/urgent");
    return data.urgent;
  }

  async function fetchAnalytics() {
    return apiFetch("/api/analytics");
  }

  // ---------- Notifications ----------
  function pushNotification(message) {
    notifications.unshift({ message, time: new Date() });
    if (notifications.length > MAX_NOTIFICATIONS) notifications.length = MAX_NOTIFICATIONS;
    unseenCount += 1;
    renderNotifications();
    showToast(message);
  }

  function renderNotifications() {
    el.bellBadge.hidden = unseenCount === 0;
    el.bellBadge.textContent = unseenCount > 9 ? "9+" : String(unseenCount);

    if (notifications.length === 0) {
      el.notificationList.innerHTML = '<p class="notification-empty">No activity yet.</p>';
      return;
    }

    el.notificationList.innerHTML = notifications.map((n) => `
      <div class="notification-item">
        <span>${escapeHtml(n.message)}</span>
        <span class="notification-item-time">${n.time.toLocaleTimeString()}</span>
      </div>
    `).join("");
  }

  function diffAndNotify(previousById, newList) {
    let newlyVotedCount = 0;
    let newlyAddedCount = 0;
    let firstVotedName = "";
    let firstAddedName = "";

    for (const e of newList) {
      const prev = previousById.get(e.id);
      if (!prev) {
        newlyAddedCount += 1;
        if (!firstAddedName) firstAddedName = e.name;
      } else if (!prev.voted && e.voted) {
        newlyVotedCount += 1;
        if (!firstVotedName) firstVotedName = e.name;
      }
    }

    if (newlyVotedCount === 1) {
      pushNotification(`📢 ${firstVotedName} has voted!`);
    } else if (newlyVotedCount > 1) {
      pushNotification(`📢 ${firstVotedName} and ${newlyVotedCount - 1} other${newlyVotedCount - 1 === 1 ? "" : "s"} just voted!`);
    }

    if (newlyAddedCount === 1) {
      pushNotification(`🆕 ${firstAddedName} was registered.`);
    } else if (newlyAddedCount > 1) {
      pushNotification(`🆕 ${firstAddedName} and ${newlyAddedCount - 1} other${newlyAddedCount - 1 === 1 ? "" : "s"} were registered.`);
    }
  }

  function diffCandidatesAndNotify(previousById, newList) {
    for (const c of newList) {
      const prev = previousById.get(c.id);
      if (prev && c.votes > prev.votes) {
        const gained = c.votes - prev.votes;
        pushNotification(`🗳️ ${c.name} (${c.position}) received ${gained === 1 ? "a vote" : `${gained} votes`} — now at ${c.votes}.`);
      } else if (!prev) {
        pushNotification(`🆕 Candidate added: ${c.name} for ${c.position}.`);
      }
    }
  }

  function toggleNotificationDropdown() {
    const willOpen = el.notificationDropdown.hidden;
    if (willOpen) {
      closeAllOverlays();
      el.notificationDropdown.hidden = false;
      unseenCount = 0;
      renderNotifications();
    } else {
      el.notificationDropdown.hidden = true;
    }
  }

  // ---------- Election countdown ----------
  function pluralize(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function renderCountdown() {
    el.countdownBanner.classList.remove("phase-before", "phase-live", "phase-closed");

    if (!electionStatus) {
      el.countdownPhaseLabel.textContent = "Loading election status…";
      el.countdownClock.textContent = "--";
      el.countdownSub.textContent = "";
      return;
    }

    const { phase, startsAt, endsAt, testMode } = electionStatus;
    el.countdownBanner.classList.add(`phase-${phase}`);

    const now = new Date();

    if (phase === "before") {
      const diff = Math.max(0, new Date(startsAt) - now);
      const s = Math.floor(diff / 1000);
      const days = Math.floor(s / 86400);
      const hours = Math.floor((s % 86400) / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = s % 60;

      el.countdownPhaseLabel.textContent = "🗳️ Voting Starts In";
      el.countdownClock.textContent =
        `${pluralize(days, "day")} ${pluralize(hours, "hour")} ${pluralize(minutes, "minute")} ${pluralize(seconds, "second")}`;
      el.countdownSub.textContent = `Opens: ${new Date(startsAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}`;
    } else if (phase === "live") {
      const diff = Math.max(0, new Date(endsAt) - now);
      const s = Math.floor(diff / 1000);
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = s % 60;

      el.countdownPhaseLabel.textContent = "🟢 VOTING IS LIVE!";
      el.countdownClock.textContent = `Closes in ${pluralize(hours, "hour")} ${pluralize(minutes, "minute")} ${pluralize(seconds, "second")}`;
      el.countdownSub.textContent = `Closes: ${new Date(endsAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}`;
    } else {
      el.countdownPhaseLabel.textContent = "🔴 VOTING CLOSED";
      el.countdownClock.textContent = "Thank you to everyone who voted.";
      el.countdownSub.textContent = `Closed: ${new Date(endsAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}`;
    }

    if (testMode) {
      el.countdownSub.textContent += " · ⚠️ TEST MODE — voting window bypassed via ALLOW_TEST_VOTES";
    }
  }

  async function refreshElectionStatus() {
    try {
      const newStatus = await fetchElectionStatus();
      const phaseChanged = electionStatus && electionStatus.phase !== newStatus.phase;
      electionStatus = newStatus;
      renderCountdown();
      render(); // vote button availability depends on phase
      if (phaseChanged) {
        if (newStatus.phase === "live") pushNotification("🟢 Voting is now LIVE!");
        if (newStatus.phase === "closed") pushNotification("🔴 Voting has closed.");
      }
    } catch (err) {
      // Election status is secondary to the main data load; fail quietly here,
      // the connection banner from loadAll() already covers DB-down cases.
    }
  }

  // ---------- Filtering (client-side, over the last loaded list) ----------
  function getFiltered() {
    const q = el.searchInput.value.trim().toLowerCase();

    return engineers.filter((e) => {
      const matchesQuery = !q ||
        e.name.toLowerCase().includes(q) ||
        e.iek_number.toLowerCase().includes(q) ||
        (e.phone || "").toLowerCase().includes(q);
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "voted" && e.voted) ||
        (activeFilter === "not-voted" && !e.voted);
      const matchesContactFilter = !activeContactFilter || e.contact_status === activeContactFilter;
      return matchesQuery && matchesFilter && matchesContactFilter;
    });
  }

  // ---------- Render: main turnout table ----------
  function render() {
    const list = getFiltered();
    const votingIsLive = electionStatus?.phase === "live";

    el.resultsCount.textContent = `${list.length} engineer${list.length === 1 ? "" : "s"}`;

    if (list.length === 0) {
      el.tableBody.innerHTML = "";
      el.emptyState.hidden = false;
    } else {
      el.emptyState.hidden = true;

      el.tableBody.innerHTML = list.map((e) => {
        const voted = !!e.voted;
        const status = e.contact_status || "pending";

        let voteAction;
        if (voted) {
          voteAction = `<span class="voted-pill">&#9989; VOTED at ${formatDateTime(e.voted_at)}</span>`;
        } else if (votingIsLive) {
          voteAction = `<button class="btn-vote" data-action="vote" data-id="${e.id}">&#128499;&#65039; VOTE</button>`;
        } else {
          const label = electionStatus?.phase === "closed" ? "Voting Closed" : "Not Open Yet";
          voteAction = `<button class="btn-vote" data-action="vote" data-id="${e.id}" disabled title="${label}">${label}</button>`;
        }

        return `
        <tr data-id="${e.id}" class="${voted ? "row-voted" : "row-not-voted"} ${e.needs_followup ? "row-urgent" : ""}">
          <td><input type="checkbox" class="row-checkbox" data-id="${e.id}" ${selectedIds.has(String(e.id)) ? "checked" : ""}></td>
          <td><span class="iek-number">${escapeHtml(e.iek_number)}</span></td>
          <td>
            <div class="candidate-cell">
              <div class="avatar">${escapeHtml(initials(e.name))}</div>
              <span>${escapeHtml(e.name)}</span>
            </div>
          </td>
          <td>${escapeHtml(e.phone || "")}</td>
          <td>
            <span class="status-badge ${voted ? "voted" : "not-voted"}">
              ${voted ? "&#9989; Voted" : "&#10060; Not Voted"}
            </span>
          </td>
          <td class="voted-timestamp">${voted && e.voted_at ? formatDateTime(e.voted_at) : "—"}</td>
          <td>
            <select class="contact-select ${status}" data-action="contact-status" data-id="${e.id}" title="${e.last_contacted_at ? `Last contacted: ${formatDateTime(e.last_contacted_at)}` : "Never contacted"} · ${e.call_count || 0} call(s)">
              ${Object.entries(CONTACT_STATUS_LABELS).map(([value, label]) =>
                `<option value="${value}" ${status === value ? "selected" : ""}>${CONTACT_STATUS_ICONS[value]} ${label}</option>`
              ).join("")}
            </select>
          </td>
          <td>
            <div class="actions-cell">
              ${voteAction}
              <button class="btn-icon-sm" data-action="call" data-id="${e.id}">&#128222; Call</button>
              <button class="btn-icon-sm" data-action="never-picked-up" data-id="${e.id}" title="Quick-log: No Answer">&#128222; Never Picked Up</button>
              <button class="btn-icon-sm" data-action="details" data-id="${e.id}">&#128065; Details</button>
              <button class="btn-icon-sm" data-action="edit" data-id="${e.id}">Edit</button>
              <button class="btn-delete" data-action="delete" data-id="${e.id}">Remove</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }

    renderBulkBar();
  }

  function renderStats(stats) {
    el.statTotal.textContent = stats.total;
    el.statVoted.textContent = stats.voted;
    el.statNotVoted.textContent = stats.notVoted;
    el.statTurnout.textContent = `${stats.turnout}%`;
    el.turnoutBarFill.style.width = `${stats.turnout}%`;
    el.statFollowUp.textContent = stats.needsFollowUp ?? 0;
  }

  function renderCandidates() {
    if (candidates.length === 0) {
      el.candidatesGrid.innerHTML = "";
      el.candidatesEmpty.hidden = false;
      return;
    }
    el.candidatesEmpty.hidden = true;

    const totalsByPosition = new Map();
    for (const c of candidates) {
      totalsByPosition.set(c.position, (totalsByPosition.get(c.position) || 0) + c.votes);
    }

    el.candidatesGrid.innerHTML = candidates.map((c) => {
      const positionTotal = totalsByPosition.get(c.position) || 0;
      const pct = positionTotal > 0 ? Math.round((c.votes / positionTotal) * 100) : 0;
      const photo = c.photo_url
        ? `<img class="candidate-card-photo" src="${escapeHtml(c.photo_url)}" alt="${escapeHtml(c.name)}">`
        : `<div class="avatar candidate-card-photo">${escapeHtml(initials(c.name))}</div>`;

      return `
        <div class="candidate-card" data-id="${c.id}">
          ${photo}
          <span class="candidate-card-position">${escapeHtml(c.position)}</span>
          <span class="candidate-card-name">${escapeHtml(c.name)}</span>
          <span class="candidate-card-votes">${c.votes}</span>
          <span class="candidate-card-votes-label">vote${c.votes === 1 ? "" : "s"} (${pct}% of ${escapeHtml(c.position)} tally)</span>
          <div class="candidate-bar-track"><div class="candidate-bar-fill" style="width:${pct}%"></div></div>
          <div class="candidate-card-actions">
            <button class="btn-tally" data-action="candidate-vote" data-id="${c.id}">+1 Vote</button>
            <button class="btn-delete" data-action="candidate-delete" data-id="${c.id}">Remove</button>
          </div>
        </div>`;
    }).join("");
  }

  // ---------- Bulk selection ----------
  function renderBulkBar() {
    el.bulkBar.hidden = selectedIds.size === 0;
    el.bulkCount.textContent = `${selectedIds.size} selected`;
    const visibleIds = getFiltered().map((e) => String(e.id));
    el.selectAllCheckbox.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  }

  function toggleRowSelection(id, checked) {
    if (checked) selectedIds.add(String(id));
    else selectedIds.delete(String(id));
    renderBulkBar();
  }

  function selectAllVisible(checked) {
    const visibleIds = getFiltered().map((e) => String(e.id));
    if (checked) visibleIds.forEach((id) => selectedIds.add(id));
    else visibleIds.forEach((id) => selectedIds.delete(id));
    render();
  }

  async function bulkApplyStatus() {
    const status = el.bulkStatusSelect.value;
    const caller = ensureIdentity();
    if (!caller) { showToast("Enter your name first to log calls.", true); return; }
    if (!confirm(`Mark ${selectedIds.size} engineer(s) as "${CONTACT_STATUS_LABELS[status]}"?`)) return;

    setBusy(true);
    try {
      await Promise.all(Array.from(selectedIds).map((id) =>
        apiFetch("/api/contact-calls", {
          method: "POST",
          body: JSON.stringify({ engineerId: Number(id), callerName: caller, callStatus: status }),
        }).catch(() => null)
      ));
      showToast(`Updated ${selectedIds.size} engineer(s).`);
      markActivity();
      selectedIds.clear();
      await loadAll({ silent: true });
      await loadUrgentAndAnalytics();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  function bulkExportSelected() {
    const rows = engineers.filter((e) => selectedIds.has(String(e.id)));
    if (rows.length === 0) return;
    const headers = ["IEK Number", "Name", "Phone", "Voted", "Contact Status", "Call Count", "Last Contacted"];
    const csvEscape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows.map((e) => [
      e.iek_number, e.name, e.phone || "", e.voted ? "Voted" : "Not Voted",
      e.contact_status, e.call_count || 0, e.last_contacted_at ? formatDateTime(e.last_contacted_at) : "",
    ])].map((r) => r.map(csvEscape).join(",")).join("\r\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `IEK_Selected_Engineers_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function bulkPrintCallList() {
    const rows = engineers.filter((e) => selectedIds.has(String(e.id)));
    if (rows.length === 0) return;
    const win = window.open("", "_blank");
    win.document.write(`
      <html><head><title>Call List — ${new Date().toLocaleDateString()}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: left; font-size: 13px; }
        th { background: #0a0a0a; color: #fff; }
      </style></head><body>
      <h2>IEK Call List — ${new Date().toLocaleString()}</h2>
      <table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Notes</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.phone || "")}</td><td>${CONTACT_STATUS_LABELS[e.contact_status] || ""}</td><td></td></tr>`).join("")}
      </tbody></table>
      </body></html>
    `);
    win.document.close();
    win.focus();
    win.print();
  }

  // ---------- Urgent ----------
  function renderUrgent(urgent) {
    el.urgentCount.textContent = `${urgent.length} flagged`;
    el.urgentNavBadge.hidden = urgent.length === 0;
    el.urgentNavBadge.textContent = urgent.length > 9 ? "9+" : String(urgent.length);

    if (urgent.length === 0) {
      el.urgentTableBody.innerHTML = "";
      el.urgentEmpty.hidden = false;
      return;
    }
    el.urgentEmpty.hidden = true;

    el.urgentTableBody.innerHTML = urgent.map((e) => {
      const reasons = [];
      if (e.reason_many_calls) reasons.push("3+ calls");
      if (e.reason_status) reasons.push(CONTACT_STATUS_LABELS[e.contact_status] || e.contact_status);
      if (e.reason_stale_remarks) reasons.push("No remark in 2 days");

      return `
        <tr data-id="${e.id}">
          <td>${escapeHtml(e.name)}</td>
          <td>${e.phone ? `<a class="phone-prominent" href="tel:${escapeHtml(e.phone)}">${escapeHtml(e.phone)}</a>` : "—"}</td>
          <td><span class="status-badge not-voted">${CONTACT_STATUS_ICONS[e.contact_status] || ""} ${CONTACT_STATUS_LABELS[e.contact_status] || e.contact_status}</span></td>
          <td>${e.call_count || 0}</td>
          <td>${e.last_contacted_at ? formatDateTime(e.last_contacted_at) : "Never"}</td>
          <td><div class="reason-tags">${reasons.map((r) => `<span class="reason-tag">${escapeHtml(r)}</span>`).join("")}</div></td>
          <td><button class="btn-icon-sm" data-action="call" data-id="${e.id}">&#128222; Call Now</button></td>
        </tr>`;
    }).join("");
  }

  // ---------- Today's Agenda (client-computed from the loaded engineers list) ----------
  function renderAgenda() {
    const list = engineers
      .filter((e) => !e.voted && e.contact_status !== "confirmed")
      .sort((a, b) => {
        const at = a.last_contacted_at ? new Date(a.last_contacted_at).getTime() : 0;
        const bt = b.last_contacted_at ? new Date(b.last_contacted_at).getTime() : 0;
        return at - bt; // never-contacted (0) first, then oldest contact first
      })
      .slice(0, 50);

    el.agendaCount.textContent = `${list.length} to call`;

    if (list.length === 0) {
      el.agendaTableBody.innerHTML = "";
      el.agendaEmpty.hidden = false;
      return;
    }
    el.agendaEmpty.hidden = true;

    el.agendaTableBody.innerHTML = list.map((e) => `
      <tr data-id="${e.id}">
        <td>${escapeHtml(e.name)}</td>
        <td>${e.phone ? `<a class="phone-prominent" href="tel:${escapeHtml(e.phone)}">${escapeHtml(e.phone)}</a>` : "—"}</td>
        <td><span class="status-badge not-voted">${CONTACT_STATUS_ICONS[e.contact_status] || ""} ${CONTACT_STATUS_LABELS[e.contact_status] || e.contact_status}</span></td>
        <td>${e.last_contacted_at ? formatDateTime(e.last_contacted_at) : "Never"}</td>
        <td><button class="btn-icon-sm" data-action="call" data-id="${e.id}">&#128222; Call</button></td>
      </tr>
    `).join("");
  }

  // ---------- Analytics (hand-rolled SVG — no external chart library) ----------
  const STATUS_COLORS = {
    pending: "#b8860b",
    confirmed: "#007a3d",
    no_answer: "#1d5fa8",
    busy_declined: "#5b7fb5",
    follow_up: "#b5540a",
    not_reachable: "#bb0a1e",
  };

  function buildPieChart(statusCounts) {
    const entries = Object.entries(statusCounts).filter(([, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (total === 0) {
      el.pieChart.innerHTML = '<p class="notification-empty">No data yet.</p>';
      el.pieChartLegend.innerHTML = "";
      return;
    }

    const cx = 100, cy = 100, r = 90;
    let angle = -90;
    const paths = entries.map(([status, count]) => {
      const slice = (count / total) * 360;
      const x1 = cx + r * Math.cos((Math.PI * angle) / 180);
      const y1 = cy + r * Math.sin((Math.PI * angle) / 180);
      angle += slice;
      const x2 = cx + r * Math.cos((Math.PI * angle) / 180);
      const y2 = cy + r * Math.sin((Math.PI * angle) / 180);
      const largeArc = slice > 180 ? 1 : 0;
      return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${STATUS_COLORS[status]}" />`;
    }).join("");

    el.pieChart.innerHTML = `<svg viewBox="0 0 200 200">${paths}</svg>`;
    el.pieChartLegend.innerHTML = entries.map(([status, count]) => `
      <span class="chart-legend-item">
        <span class="chart-legend-swatch" style="background:${STATUS_COLORS[status]}"></span>
        ${CONTACT_STATUS_LABELS[status]}: ${count}
      </span>
    `).join("");
  }

  function buildBarChart(dailyData, color) {
    if (!dailyData || dailyData.length === 0) {
      el.barChart.innerHTML = '<p class="notification-empty">No calls logged in the last 7 days.</p>';
      return;
    }
    const max = Math.max(...dailyData.map((d) => d.count), 1);
    const barWidth = 100 / dailyData.length;
    const bars = dailyData.map((d, i) => {
      const h = (d.count / max) * 140;
      const x = i * barWidth + barWidth * 0.15;
      const w = barWidth * 0.7;
      const y = 160 - h;
      const label = d.date.slice(5); // MM-DD
      return `
        <rect x="${x}%" y="${y}" width="${w}%" height="${h}" fill="${color}" rx="2"></rect>
        <text x="${(x + w / 2)}%" y="175" font-size="9" text-anchor="middle" fill="#6b7280">${label}</text>
        <text x="${(x + w / 2)}%" y="${y - 4}" font-size="10" text-anchor="middle" fill="#1b1d22">${d.count}</text>
      `;
    }).join("");
    el.barChart.innerHTML = `<svg viewBox="0 0 300 190" preserveAspectRatio="none">${bars}</svg>`;
  }

  function buildLineChart(dailyData, color) {
    if (!dailyData || dailyData.length === 0) {
      el.lineChart.innerHTML = '<p class="notification-empty">No confirmations logged in the last 7 days.</p>';
      return;
    }
    const max = Math.max(...dailyData.map((d) => d.count), 1);
    const stepX = dailyData.length > 1 ? 280 / (dailyData.length - 1) : 0;
    const points = dailyData.map((d, i) => {
      const x = 10 + i * stepX;
      const y = 150 - (d.count / max) * 130;
      return { x, y, count: d.count, date: d.date };
    });
    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dots = points.map((p) => `
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}"></circle>
      <text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" font-size="10" text-anchor="middle" fill="#1b1d22">${p.count}</text>
      <text x="${p.x.toFixed(1)}" y="168" font-size="9" text-anchor="middle" fill="#6b7280">${p.date.slice(5)}</text>
    `).join("");

    el.lineChart.innerHTML = `<svg viewBox="0 0 300 180" preserveAspectRatio="none">
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2"></path>
      ${dots}
    </svg>`;
  }

  function renderAnalytics(data) {
    el.anaTotal.textContent = data.total;
    el.anaConfirmed.textContent = data.statusCounts.confirmed;
    el.anaNoAnswer.textContent = data.statusCounts.no_answer + data.statusCounts.busy_declined;
    el.anaFollowUp.textContent = data.statusCounts.follow_up;
    el.anaNotReachable.textContent = data.statusCounts.not_reachable;
    el.anaPending.textContent = data.statusCounts.pending;
    el.anaTurnout.textContent = `${data.turnout}%`;

    buildPieChart(data.statusCounts);
    buildBarChart(data.dailyCalls, "#0a0a0a");
    buildLineChart(data.dailyConfirmations, "#007a3d");
  }

  async function loadUrgentAndAnalytics() {
    try {
      const [urgent, analytics] = await Promise.all([fetchUrgent(), fetchAnalytics()]);
      renderUrgent(urgent);
      renderAnalytics(analytics);
    } catch (err) {
      // Non-fatal — main table still works even if this secondary data fails.
    }
  }

  // ---------- Load everything from the API ----------
  async function loadAll({ silent, isPoll } = {}) {
    try {
      const [engineersList, stats, candidatesList] = await Promise.all([
        fetchEngineers(), fetchStats(), fetchCandidates(),
      ]);

      if (isPoll && hasLoadedOnce) {
        diffAndNotify(engineersById, engineersList);
        diffCandidatesAndNotify(candidatesById, candidatesList);
      }

      engineers = engineersList;
      engineersById = new Map(engineers.map((e) => [e.id, e]));
      candidates = candidatesList;
      candidatesById = new Map(candidates.map((c) => [c.id, c]));
      hasLoadedOnce = true;

      hideConnectionError();
      render();
      renderStats(stats);
      renderCandidates();
      renderAgenda();
      el.lastUpdated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
      if (!silent) showToast("Data refreshed from the database.");
    } catch (err) {
      showConnectionError(err.message || "Could not load data from the database.");
      if (!silent) showToast(err.message, true);
    }
  }

  // ---------- Polling ----------
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      await loadAll({ silent: true, isPoll: true });
      await loadUrgentAndAnalytics();
    }, POLL_INTERVAL_MS);
  }

  function startCountdownTicking() {
    // Two independent timers: the display ticks every second (smooth
    // countdown), while the authoritative phase is re-fetched from the
    // server every 5s (POLL_INTERVAL_MS) so client clock drift can never
    // keep voting open/closed longer than the server says it should.
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(renderCountdown, COUNTDOWN_TICK_MS);
    setInterval(refreshElectionStatus, POLL_INTERVAL_MS);
  }

  // ---------- Form (Add / Edit) ----------
  function openFormForAdd() {
    el.engineerForm.reset();
    el.engineerId.value = "";
    el.formTitle.textContent = "Register New Engineer";
    el.formSubmitBtn.textContent = "Register Engineer";
    el.formPanel.hidden = false;
    document.getElementById("iekNumber").focus();
  }

  function openFormForEdit(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    el.engineerId.value = e.id;
    document.getElementById("iekNumber").value = e.iek_number;
    document.getElementById("fullName").value = e.name;
    document.getElementById("phone").value = e.phone || "";
    el.formTitle.textContent = `Edit Engineer — ${e.name}`;
    el.formSubmitBtn.textContent = "Update Engineer";
    el.formPanel.hidden = false;
    document.getElementById("iekNumber").focus();
  }

  function closeForm() {
    el.engineerForm.reset();
    el.engineerId.value = "";
    el.formPanel.hidden = true;
  }

  async function submitForm(evt) {
    evt.preventDefault();
    if (isBusy) return;

    const id = el.engineerId.value;
    const iekNumber = document.getElementById("iekNumber").value.trim();
    const name = document.getElementById("fullName").value.trim();
    const phone = document.getElementById("phone").value.trim();

    if (!iekNumber || !name) {
      showToast("IEK Number and Name are required.", true);
      return;
    }

    setBusy(true);
    try {
      if (id) {
        await apiFetch(`/api/engineers/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name, phone }),
        });
        showToast(`${name} updated successfully.`);
      } else {
        await apiFetch("/api/engineers", {
          method: "POST",
          body: JSON.stringify({ iekNumber, name, phone }),
        });
        showToast(`${name} registered successfully.`);
      }
      closeForm();
      markActivity();
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Actions ----------
  async function deleteEngineer(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    if (!confirm(`Remove ${e.name} (${e.iek_number}) from the register? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, { method: "DELETE" });
      showToast(`${e.name} has been removed.`);
      selectedIds.delete(String(id));
      markActivity();
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function markVoted(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e || e.voted) return;
    if (!confirm(`Confirm that ${e.name} (${e.iek_number}) has cast their vote? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ voted: true }),
      });
      showToast(`✅ ${e.name} has voted!`);
      markActivity();
      await loadAll({ silent: true });
      await loadUrgentAndAnalytics();
    } catch (err) {
      showToast(err.message, true);
      await refreshElectionStatus(); // in case the window just closed/hasn't opened
    } finally {
      setBusy(false);
    }
  }

  async function quickSetContactStatus(id, status) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    const caller = ensureIdentity();
    if (!caller) { showToast("Enter your name first to log a call.", true); render(); return; }

    setBusy(true);
    try {
      await apiFetch("/api/contact-calls", {
        method: "POST",
        body: JSON.stringify({ engineerId: Number(id), callerName: caller, callStatus: status }),
      });
      showToast(`${e.name}: marked as "${CONTACT_STATUS_LABELS[status]}".`);
      markActivity();
      await loadAll({ silent: true });
      await loadUrgentAndAnalytics();
    } catch (err) {
      showToast(err.message, true);
      await loadAll({ silent: true }); // re-sync the dropdown to the real server value
    } finally {
      setBusy(false);
    }
  }

  async function quickNeverPickedUp(id) {
    await quickSetContactStatus(id, "no_answer");
  }

  async function resetAllVotes() {
    if (!confirm("Reset ALL voting statuses to 'Not Voted'? This cannot be undone. Only do this before the real voting window opens.")) return;

    setBusy(true);
    try {
      await apiFetch("/api/reset-votes", { method: "POST" });
      showToast("All voting statuses have been reset.");
      markActivity();
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Overlay management (only one modal/dropdown open at a time) ----------
  function closeAllOverlays() {
    el.callModalOverlay.hidden = true;
    el.detailsModalOverlay.hidden = true;
    el.notificationDropdown.hidden = true;
    el.exportDropdown.hidden = true;
  }

  // ---------- Log Call modal ----------
  function openCallModal(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    closeAllOverlays();
    ensureIdentity();
    callModalStatus = null;
    el.callEngineerId.value = e.id;
    el.callModalName.textContent = e.name;
    el.callModalPhone.innerHTML = e.phone ? `<a href="tel:${escapeHtml(e.phone)}">${escapeHtml(e.phone)}</a>` : "No phone on file";
    el.callNotes.value = "";
    el.callForm.querySelectorAll(".call-status-btn").forEach((b) => b.classList.remove("selected"));
    el.callSubmitBtn.disabled = true;
    el.callModalOverlay.hidden = false;
  }

  function closeCallModal() {
    el.callModalOverlay.hidden = true;
  }

  async function submitCallForm(evt) {
    evt.preventDefault();
    if (isBusy || !callModalStatus) return;
    const id = el.callEngineerId.value;
    const caller = ensureIdentity();
    if (!caller) { showToast("Enter your name first.", true); return; }

    setBusy(true);
    try {
      await apiFetch("/api/contact-calls", {
        method: "POST",
        body: JSON.stringify({
          engineerId: Number(id),
          callerName: caller,
          callStatus: callModalStatus,
          notes: el.callNotes.value.trim() || undefined,
        }),
      });
      showToast("Call logged.");
      markActivity();
      closeCallModal();
      await loadAll({ silent: true });
      await loadUrgentAndAnalytics();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Engineer Details modal ----------
  async function openDetailsModal(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    closeAllOverlays();

    el.detailsModalName.textContent = `${e.name} (${e.iek_number})`;
    el.detailsModalBody.innerHTML = "<p>Loading history…</p>";
    el.detailsModalOverlay.hidden = false;

    try {
      const [callsData, remarksData] = await Promise.all([
        apiFetch(`/api/contact-calls?engineerId=${e.id}`),
        apiFetch(`/api/remarks?engineerId=${e.id}`),
      ]);

      const timeline = [
        ...(e.voted_at ? [{ at: e.voted_at, action: "Voted", person: "System", notes: `✅ Voted at ${formatDateTime(e.voted_at)}` }] : []),
        ...callsData.calls.map((c) => ({ at: c.called_at, action: "Called", person: c.caller_name, notes: `${CONTACT_STATUS_ICONS[c.call_status] || ""} ${CONTACT_STATUS_LABELS[c.call_status] || c.call_status}${c.notes ? " — " + c.notes : ""}` })),
        ...remarksData.remarks.map((r) => ({ at: r.created_at, action: "Remark", person: r.author, notes: r.remark })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at));

      const detailGrid = `
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-item-label">Voted</div><div class="detail-item-value">${e.voted ? `Yes — ${formatDateTime(e.voted_at)}` : "No"}</div></div>
          <div class="detail-item"><div class="detail-item-label">Call Status</div><div class="detail-item-value">${CONTACT_STATUS_ICONS[e.contact_status] || ""} ${CONTACT_STATUS_LABELS[e.contact_status] || e.contact_status}</div></div>
          <div class="detail-item"><div class="detail-item-label">Calls Made</div><div class="detail-item-value">${e.call_count || 0}</div></div>
          <div class="detail-item"><div class="detail-item-label">Last Contact</div><div class="detail-item-value">${e.last_contacted_at ? formatDateTime(e.last_contacted_at) : "Never"}</div></div>
        </div>
        ${e.remarks ? `<p><em>Legacy imported note: ${escapeHtml(e.remarks)}</em></p>` : ""}
        <div class="form-actions" style="margin-bottom:14px;">
          <button class="btn btn-primary btn-sm" id="detailsLogCallBtn" data-id="${e.id}">&#128222; Log Call</button>
          <button class="btn btn-outline btn-sm" id="detailsAddRemarkBtn" data-id="${e.id}">&#128221; Add Remark</button>
        </div>
        <div class="history-table-wrap">
          <table class="history-table">
            <thead><tr><th>Date/Time</th><th>Action</th><th>Person</th><th>Notes</th></tr></thead>
            <tbody>
              ${timeline.length === 0
                ? `<tr><td colspan="4">No history yet.</td></tr>`
                : timeline.map((t) => `<tr><td>${formatDateTime(t.at)}</td><td>${escapeHtml(t.action)}</td><td>${escapeHtml(t.person || "")}</td><td>${escapeHtml(t.notes || "")}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      `;
      el.detailsModalBody.innerHTML = detailGrid;

      document.getElementById("detailsLogCallBtn").addEventListener("click", () => {
        closeDetailsModal();
        openCallModal(e.id);
      });
      document.getElementById("detailsAddRemarkBtn").addEventListener("click", () => addRemark(e.id));
    } catch (err) {
      el.detailsModalBody.innerHTML = `<p>Failed to load history: ${escapeHtml(err.message)}</p>`;
    }
  }

  function closeDetailsModal() {
    el.detailsModalOverlay.hidden = true;
  }

  async function addRemark(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    const author = ensureIdentity();
    if (!author) { showToast("Enter your name first to add a remark.", true); return; }

    const text = prompt(`Remark for ${e.name} (${e.iek_number}):`, "");
    if (text === null || !text.trim()) return;

    setBusy(true);
    try {
      await apiFetch("/api/remarks", {
        method: "POST",
        body: JSON.stringify({ engineerId: Number(id), author, remark: text.trim() }),
      });
      showToast(`Remark added: "📝 ${author} — ${text.trim()}"`);
      markActivity();
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Candidates ----------
  function openCandidateForm() {
    el.candidateForm.reset();
    el.candidateForm.hidden = false;
    document.getElementById("candidateName").focus();
  }

  function closeCandidateForm() {
    el.candidateForm.reset();
    el.candidateForm.hidden = true;
  }

  async function submitCandidateForm(evt) {
    evt.preventDefault();
    if (isBusy) return;

    const name = document.getElementById("candidateName").value.trim();
    const position = document.getElementById("candidatePosition").value.trim();
    const photoUrl = document.getElementById("candidatePhotoUrl").value.trim();
    if (!name || !position) {
      showToast("Candidate name and position are required.", true);
      return;
    }

    setBusy(true);
    try {
      await apiFetch("/api/candidates", {
        method: "POST",
        body: JSON.stringify({ name, position, photoUrl }),
      });
      showToast(`${name} added as a candidate for ${position}.`);
      closeCandidateForm();
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function voteCandidate(id) {
    const c = candidates.find((x) => String(x.id) === String(id));
    if (!c) return;
    if (!confirm(`Record one counted ballot for ${c.name} (${c.position})?`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/candidates/${id}/vote`, { method: "POST" });
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCandidate(id) {
    const c = candidates.find((x) => String(x.id) === String(id));
    if (!c) return;
    if (!confirm(`Remove candidate ${c.name} (${c.position})? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/candidates/${id}`, { method: "DELETE" });
      showToast(`${c.name} removed from candidates.`);
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Bulk import ----------
  async function handleImportFile(evt) {
    const file = evt.target.files[0];
    evt.target.value = "";
    if (!file) return;

    const text = await file.text();
    setBusy(true);
    try {
      const result = await apiFetch("/api/import", {
        method: "POST",
        body: JSON.stringify({ csv: text }),
      });

      let msg = `Imported ${result.inserted} engineer${result.inserted === 1 ? "" : "s"}.`;
      if (result.skipped) msg += ` ${result.skipped} skipped (already existed).`;
      if (result.errors && result.errors.length) msg += ` ${result.errors.length} row(s) had errors.`;

      const isMostlyError = result.inserted === 0 && result.errors && result.errors.length > 0;
      showToast(msg, isMostlyError);
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Export / Print ----------
  function toggleExportDropdown() {
    const willOpen = el.exportDropdown.hidden;
    if (willOpen) {
      closeAllOverlays();
      el.exportDropdown.hidden = false;
    } else {
      el.exportDropdown.hidden = true;
    }
  }

  function printResults() {
    window.print();
  }

  // "Full Report (PDF)": builds a standalone printable document with fresh
  // data (stats, call-status breakdown, candidate results, full voter list)
  // and opens the browser's print dialog. Choosing "Save as PDF" there is
  // how this becomes a PDF — deliberately not a server-side PDF library
  // (pdfkit/puppeteer are heavy, and puppeteer especially is a real risk to
  // add on a serverless function two days before a real election). Every
  // modern browser's native print-to-PDF is effectively zero-risk by
  // comparison and needs no new dependency at all.
  async function openFullReportPrintView() {
    showToast("Generating full report…");
    try {
      const [stats, analytics, candidatesList, engineersList] = await Promise.all([
        fetchStats(), fetchAnalytics(), fetchCandidates(), fetchEngineers(),
      ]);

      const win = window.open("", "_blank");
      if (!win) {
        showToast("Your browser blocked the report popup — allow popups for this site and try again.", true);
        return;
      }

      const now = new Date().toLocaleString();

      const statusRows = Object.entries(analytics.statusCounts).map(([status, count]) => `
        <tr><td>${CONTACT_STATUS_ICONS[status] || ""} ${escapeHtml(CONTACT_STATUS_LABELS[status] || status)}</td><td>${count}</td></tr>
      `).join("");

      const candidateRows = candidatesList.map((c) => `
        <tr><td>${escapeHtml(c.position)}</td><td>${escapeHtml(c.name)}</td><td>${c.votes}</td></tr>
      `).join("");

      const engineerRows = engineersList.map((e) => `
        <tr>
          <td>${escapeHtml(e.iek_number)}</td>
          <td>${escapeHtml(e.name)}</td>
          <td>${escapeHtml(e.phone || "")}</td>
          <td>${e.voted ? "Voted" : "Not Voted"}</td>
          <td>${escapeHtml(CONTACT_STATUS_LABELS[e.contact_status] || e.contact_status)}</td>
        </tr>
      `).join("");

      win.document.write(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>IEK Full Report — ${now}</title>
        <style>
          body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #1b1d22; }
          h1 { margin-bottom: 4px; }
          .subtitle { color: #6b7280; margin-bottom: 20px; }
          h2 { margin-top: 28px; border-bottom: 2px solid #0a0a0a; padding-bottom: 4px; font-size: 16px; }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; }
          th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 12px; }
          th { background: #0a0a0a; color: #fff; }
          .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
          .stat-box { border: 1px solid #ccc; border-radius: 6px; padding: 8px 14px; min-width: 110px; }
          .stat-box .value { font-size: 20px; font-weight: 800; display: block; }
          .stat-box .label { font-size: 10px; color: #6b7280; text-transform: uppercase; }
          @media print { body { padding: 0; } }
        </style></head><body>
        <h1>IEK Online Voting System — Full Report</h1>
        <p class="subtitle">Generated: ${now}</p>

        <h2>Turnout Summary</h2>
        <div class="stat-row">
          <div class="stat-box"><span class="value">${stats.total}</span><span class="label">Total Registered</span></div>
          <div class="stat-box"><span class="value">${stats.voted}</span><span class="label">Voted</span></div>
          <div class="stat-box"><span class="value">${stats.notVoted}</span><span class="label">Not Voted</span></div>
          <div class="stat-box"><span class="value">${stats.turnout}%</span><span class="label">Turnout</span></div>
          <div class="stat-box"><span class="value">${stats.needsFollowUp}</span><span class="label">Needs Follow-up</span></div>
        </div>

        <h2>Call Status Breakdown</h2>
        <table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${statusRows}</tbody></table>

        <h2>Candidate Results</h2>
        ${candidatesList.length === 0
          ? "<p>No candidates added yet.</p>"
          : `<table><thead><tr><th>Position</th><th>Candidate</th><th>Votes</th></tr></thead><tbody>${candidateRows}</tbody></table>`}

        <h2>Full Voter List (${engineersList.length})</h2>
        <table><thead><tr><th>IEK Number</th><th>Name</th><th>Phone</th><th>Voted</th><th>Contact Status</th></tr></thead><tbody>${engineerRows}</tbody></table>
        </body></html>
      `);
      win.document.close();
      win.focus();
      // Small delay so the new document has actually painted before the
      // print dialog opens — printing an unrendered document can come out blank.
      setTimeout(() => win.print(), 300);
    } catch (err) {
      showToast(`Failed to generate report: ${err.message}`, true);
    }
  }

  // ---------- Audit log ----------
  async function toggleAuditPanel() {
    const willOpen = el.auditPanel.hidden;
    el.auditPanel.hidden = !willOpen;
    if (!willOpen) return;

    el.auditTableBody.innerHTML = `<tr><td colspan="4">Loading…</td></tr>`;
    try {
      const data = await apiFetch("/api/audit-log");
      if (data.entries.length === 0) {
        el.auditTableBody.innerHTML = `<tr><td colspan="4">No audit entries yet.</td></tr>`;
        return;
      }
      el.auditTableBody.innerHTML = data.entries.map((entry) => `
        <tr>
          <td>${formatDateTime(entry.timestamp)}</td>
          <td>${escapeHtml(entry.action)}</td>
          <td>${entry.iek_number ? escapeHtml(`${entry.name} (${entry.iek_number})`) : "—"}</td>
          <td>${escapeHtml(entry.user_ip || "")}</td>
        </tr>
      `).join("");
    } catch (err) {
      el.auditTableBody.innerHTML = `<tr><td colspan="4">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ---------- Clock ----------
  function tickClock() {
    const now = new Date();
    el.clock.textContent = now.toLocaleString("en-KE", {
      weekday: "short", year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  // ---------- Event wiring ----------
  function bindEvents() {
    el.toggleFormBtn.addEventListener("click", () => {
      if (el.formPanel.hidden) openFormForAdd();
      else closeForm();
    });

    el.cancelFormBtn.addEventListener("click", closeForm);
    el.engineerForm.addEventListener("submit", submitForm);

    el.searchInput.addEventListener("input", render);

    el.filterBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        el.filterBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeFilter = btn.getAttribute("data-filter");
        render();
      });
    });

    el.contactFilter.addEventListener("change", () => {
      activeContactFilter = el.contactFilter.value;
      render();
    });

    el.importCsvBtn.addEventListener("click", () => el.importCsvInput.click());
    el.importCsvInput.addEventListener("change", handleImportFile);

    el.exportCsvBtn.addEventListener("click", toggleExportDropdown);
    el.exportDropdown.addEventListener("click", (evt) => {
      const formatBtn = evt.target.closest("button[data-format]");
      if (formatBtn) {
        activeExportFormat = formatBtn.getAttribute("data-format");
        el.exportDropdown.querySelectorAll(".export-format-btn").forEach((b) => b.classList.remove("active"));
        formatBtn.classList.add("active");
        return; // keep the dropdown open so the user can now pick a report
      }

      const btn = evt.target.closest("button[data-type]");
      if (!btn) return;
      window.open(`/api/export?type=${btn.getAttribute("data-type")}&format=${activeExportFormat}`, "_blank");
      el.exportDropdown.hidden = true;
    });
    el.fullReportPdfBtn.addEventListener("click", () => {
      el.exportDropdown.hidden = true;
      openFullReportPrintView();
    });
    document.addEventListener("click", (evt) => {
      if (!el.exportDropdown.hidden && !el.exportDropdown.contains(evt.target) && evt.target !== el.exportCsvBtn) {
        el.exportDropdown.hidden = true;
      }
    });

    el.printBtn.addEventListener("click", printResults);
    el.resetVotesBtn.addEventListener("click", resetAllVotes);
    el.refreshBtn.addEventListener("click", async () => {
      await loadAll();
      await loadUrgentAndAnalytics();
    });
    el.retryConnectionBtn.addEventListener("click", () => loadAll());

    el.notificationBell.addEventListener("click", toggleNotificationDropdown);
    document.addEventListener("click", (evt) => {
      if (!el.notificationDropdown.hidden &&
          !el.notificationDropdown.contains(evt.target) &&
          evt.target !== el.notificationBell) {
        el.notificationDropdown.hidden = true;
      }
    });

    el.identityBadge.addEventListener("click", () => {
      const current = getIdentity();
      const name = prompt("Your name (shown on every call log / remark you add):", current);
      if (name && name.trim()) setIdentity(name);
    });

    el.quickNavBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(btn.getAttribute("data-target"))?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    el.auditLogBtn.addEventListener("click", toggleAuditPanel);
    el.closeAuditBtn.addEventListener("click", () => { el.auditPanel.hidden = true; });

    el.toggleCandidateFormBtn.addEventListener("click", () => {
      if (el.candidateForm.hidden) openCandidateForm();
      else closeCandidateForm();
    });
    el.cancelCandidateFormBtn.addEventListener("click", closeCandidateForm);
    el.candidateForm.addEventListener("submit", submitCandidateForm);

    el.candidatesGrid.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn || isBusy) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "candidate-vote") voteCandidate(id);
      if (action === "candidate-delete") deleteCandidate(id);
    });

    // Bulk selection
    el.selectAllCheckbox.addEventListener("change", (evt) => selectAllVisible(evt.target.checked));
    el.tableBody.addEventListener("change", (evt) => {
      const checkbox = evt.target.closest(".row-checkbox");
      if (checkbox) { toggleRowSelection(checkbox.getAttribute("data-id"), checkbox.checked); return; }

      const select = evt.target.closest('select[data-action="contact-status"]');
      if (select && !isBusy) quickSetContactStatus(select.getAttribute("data-id"), select.value);
    });
    el.bulkApplyBtn.addEventListener("click", bulkApplyStatus);
    el.bulkExportBtn.addEventListener("click", bulkExportSelected);
    el.bulkPrintBtn.addEventListener("click", bulkPrintCallList);
    el.bulkClearBtn.addEventListener("click", () => { selectedIds.clear(); render(); });

    el.tableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn || isBusy || btn.disabled) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "vote") markVoted(id);
      if (action === "call") openCallModal(id);
      if (action === "never-picked-up") quickNeverPickedUp(id);
      if (action === "details") openDetailsModal(id);
      if (action === "edit") openFormForEdit(id);
      if (action === "delete") deleteEngineer(id);
    });

    el.urgentTableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn) return;
      if (btn.getAttribute("data-action") === "call") openCallModal(btn.getAttribute("data-id"));
    });

    el.agendaTableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn) return;
      if (btn.getAttribute("data-action") === "call") openCallModal(btn.getAttribute("data-id"));
    });

    // Call modal
    el.callForm.querySelectorAll(".call-status-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        el.callForm.querySelectorAll(".call-status-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        callModalStatus = btn.getAttribute("data-status");
        el.callSubmitBtn.disabled = false;
      });
    });
    el.callForm.addEventListener("submit", submitCallForm);
    el.callCancelBtn.addEventListener("click", closeCallModal);
    el.callModalClose.addEventListener("click", closeCallModal);
    el.callModalOverlay.addEventListener("click", (evt) => {
      if (evt.target === el.callModalOverlay) closeCallModal();
    });

    // Details modal
    el.detailsModalClose.addEventListener("click", closeDetailsModal);
    el.detailsModalOverlay.addEventListener("click", (evt) => {
      if (evt.target === el.detailsModalOverlay) closeDetailsModal();
    });
  }

  // ---------- Init ----------
  async function init() {
    bindEvents();
    renderIdentityBadge();
    el.year.textContent = new Date().getFullYear();
    tickClock();
    setInterval(tickClock, 1000);

    await refreshElectionStatus();
    await loadAll({ silent: true });
    await loadUrgentAndAnalytics();

    startPolling();
    startCountdownTicking();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
