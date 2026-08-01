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

  let engineers = [];
  let engineersById = new Map();
  let candidates = [];
  let candidatesById = new Map();
  let hasLoadedOnce = false;
  let activeFilter = "all"; // all | voted | not-voted
  let activeContactFilter = ""; // "" | not_contacted | confirmed | follow_up | declined
  let isBusy = false;

  let electionStatus = null; // { phase, startsAt, endsAt, serverTime, testMode }
  let notifications = [];
  let unseenCount = 0;

  let pollTimer = null;
  let countdownTimer = null;

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
    printBtn: document.getElementById("printBtn"),
    resetVotesBtn: document.getElementById("resetVotesBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    lastUpdated: document.getElementById("lastUpdated"),
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
    el.notificationDropdown.hidden = !willOpen;
    if (willOpen) {
      unseenCount = 0;
      renderNotifications();
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

  const CONTACT_STATUS_LABELS = {
    not_contacted: "Not Contacted",
    confirmed: "Confirmed",
    follow_up: "Needs Follow-up",
    declined: "Declined",
  };

  // ---------- Render ----------
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
        const remarks = e.remarks ? escapeHtml(e.remarks) : '<span class="remarks-text empty">No remarks</span>';

        let voteAction;
        if (voted) {
          voteAction = `
            <span class="voted-pill">&#9989; ALREADY VOTED</span>
            <button class="btn-undo" data-action="undo" data-id="${e.id}" title="Admin correction">Undo</button>`;
        } else if (votingIsLive) {
          voteAction = `<button class="btn-vote" data-action="vote" data-id="${e.id}">&#128499;&#65039; VOTE</button>`;
        } else {
          const label = electionStatus?.phase === "closed" ? "Voting Closed" : "Not Open Yet";
          voteAction = `<button class="btn-vote" data-action="vote" data-id="${e.id}" disabled title="${label}">${label}</button>`;
        }

        return `
        <tr data-id="${e.id}" class="${voted ? "row-voted" : "row-not-voted"}">
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
            <select class="contact-select ${e.contact_status || "not_contacted"}" data-action="contact-status" data-id="${e.id}" title="${e.last_contacted_at ? `Last contacted: ${formatDateTime(e.last_contacted_at)}` : "Never contacted"}">
              ${Object.entries(CONTACT_STATUS_LABELS).map(([value, label]) =>
                `<option value="${value}" ${(e.contact_status || "not_contacted") === value ? "selected" : ""}>${label}</option>`
              ).join("")}
            </select>
          </td>
          <td class="remarks-cell">${e.remarks ? `<span class="remarks-text">${remarks}</span>` : remarks}</td>
          <td>
            <div class="actions-cell">
              ${voteAction}
              <button class="btn-icon-sm" data-action="remarks" data-id="${e.id}">Remarks</button>
              <button class="btn-icon-sm" data-action="edit" data-id="${e.id}">Edit</button>
              <button class="btn-delete" data-action="delete" data-id="${e.id}">Remove</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }
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
    pollTimer = setInterval(() => loadAll({ silent: true, isPoll: true }), POLL_INTERVAL_MS);
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
    document.getElementById("remarks").value = e.remarks || "";
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
    const remarks = document.getElementById("remarks").value.trim();

    if (!iekNumber || !name) {
      showToast("IEK Number and Name are required.", true);
      return;
    }

    setBusy(true);
    try {
      if (id) {
        await apiFetch(`/api/engineers/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name, phone, remarks }),
        });
        showToast(`${name} updated successfully.`);
      } else {
        await apiFetch("/api/engineers", {
          method: "POST",
          body: JSON.stringify({ iekNumber, name, phone, remarks }),
        });
        showToast(`${name} registered successfully.`);
      }
      closeForm();
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
    if (!confirm(`Confirm that ${e.name} (${e.iek_number}) has cast their vote?`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ voted: true }),
      });
      showToast(`${e.name} marked as Voted.`);
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
      await refreshElectionStatus(); // in case the window just closed/hasn't opened
    } finally {
      setBusy(false);
    }
  }

  async function undoVote(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    if (!confirm(`Undo voting status for ${e.name} (${e.iek_number})?`)) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ voted: false }),
      });
      showToast(`Voting status reverted for ${e.name}.`);
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function editRemarks(id) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;
    const value = prompt(`Remarks for ${e.name} (${e.iek_number}):`, e.remarks || "");
    if (value === null) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ remarks: value.trim() }),
      });
      showToast("Remarks updated.");
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function setContactStatus(id, contactStatus) {
    const e = engineers.find((x) => String(x.id) === String(id));
    if (!e) return;

    setBusy(true);
    try {
      await apiFetch(`/api/engineers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ contactStatus }),
      });
      showToast(`${e.name}: marked as "${CONTACT_STATUS_LABELS[contactStatus]}".`);
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err.message, true);
      await loadAll({ silent: true }); // re-sync the dropdown to the real server value
    } finally {
      setBusy(false);
    }
  }

  async function resetAllVotes() {
    if (!confirm("Reset ALL voting statuses to 'Not Voted'? This cannot be undone.")) return;

    setBusy(true);
    try {
      await apiFetch("/api/reset-votes", { method: "POST" });
      showToast("All voting statuses have been reset.");
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
  function exportCSV() {
    window.open("/api/export", "_blank");
  }

  function printResults() {
    window.print();
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
    el.exportCsvBtn.addEventListener("click", exportCSV);
    el.printBtn.addEventListener("click", printResults);
    el.resetVotesBtn.addEventListener("click", resetAllVotes);
    el.refreshBtn.addEventListener("click", () => loadAll());
    el.retryConnectionBtn.addEventListener("click", () => loadAll());

    el.notificationBell.addEventListener("click", toggleNotificationDropdown);
    document.addEventListener("click", (evt) => {
      if (!el.notificationDropdown.hidden &&
          !el.notificationDropdown.contains(evt.target) &&
          evt.target !== el.notificationBell) {
        el.notificationDropdown.hidden = true;
      }
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

    el.tableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn || isBusy || btn.disabled) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "vote") markVoted(id);
      if (action === "undo") undoVote(id);
      if (action === "remarks") editRemarks(id);
      if (action === "edit") openFormForEdit(id);
      if (action === "delete") deleteEngineer(id);
    });

    el.tableBody.addEventListener("change", (evt) => {
      const select = evt.target.closest('select[data-action="contact-status"]');
      if (!select || isBusy) return;
      setContactStatus(select.getAttribute("data-id"), select.value);
    });
  }

  // ---------- Init ----------
  async function init() {
    bindEvents();
    el.year.textContent = new Date().getFullYear();
    tickClock();
    setInterval(tickClock, 1000);

    await refreshElectionStatus();
    await loadAll({ silent: true });

    startPolling();
    startCountdownTicking();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
