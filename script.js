/* =========================================================
   IEK Online Voting System — Application Logic
   Data persistence: Neon PostgreSQL via Vercel Functions (/api/*)
   All localStorage code has been removed — every action hits
   the API, so every visitor sees the same live data.
   ========================================================= */

(function () {
  "use strict";

  let engineers = [];
  let activeFilter = "all"; // all | voted | not-voted
  let isBusy = false;

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
    toast: document.getElementById("toast"),
    statTotal: document.getElementById("statTotal"),
    statVoted: document.getElementById("statVoted"),
    statNotVoted: document.getElementById("statNotVoted"),
    statTurnout: document.getElementById("statTurnout"),
    turnoutBarFill: document.getElementById("turnoutBarFill"),
    connectionBanner: document.getElementById("connectionBanner"),
    connectionBannerText: document.getElementById("connectionBannerText"),
    retryConnectionBtn: document.getElementById("retryConnectionBtn"),
    clock: document.getElementById("clock"),
    year: document.getElementById("year"),
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
      // response had no JSON body (e.g. 204) — fine for some endpoints
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
      return matchesQuery && matchesFilter;
    });
  }

  // ---------- Render ----------
  function render() {
    const list = getFiltered();

    el.resultsCount.textContent = `${list.length} engineer${list.length === 1 ? "" : "s"}`;

    if (list.length === 0) {
      el.tableBody.innerHTML = "";
      el.emptyState.hidden = false;
    } else {
      el.emptyState.hidden = true;

      el.tableBody.innerHTML = list.map((e) => {
        const voted = !!e.voted;
        const remarks = e.remarks ? escapeHtml(e.remarks) : '<span class="remarks-text empty">No remarks</span>';

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
          <td class="remarks-cell">${e.remarks ? `<span class="remarks-text">${remarks}</span>` : remarks}</td>
          <td>
            <div class="actions-cell">
              ${voted
                ? `<button class="btn-undo" data-action="undo" data-id="${e.id}">Undo</button>`
                : `<button class="btn-vote" data-action="vote" data-id="${e.id}">Mark Voted</button>`
              }
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
  }

  // ---------- Load everything from the API ----------
  async function loadAll({ silent } = {}) {
    setBusy(true);
    try {
      const [engineersList, stats] = await Promise.all([fetchEngineers(), fetchStats()]);
      engineers = engineersList;
      hideConnectionError();
      render();
      renderStats(stats);
      if (!silent) showToast("Data refreshed from the database.");
    } catch (err) {
      showConnectionError(err.message || "Could not load data from the database.");
      if (!silent) showToast(err.message, true);
    } finally {
      setBusy(false);
    }
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

    if (!iekNumber || !name || !phone) {
      showToast("Please fill in all required fields.", true);
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

  // ---------- Bulk import ----------
  async function handleImportFile(evt) {
    const file = evt.target.files[0];
    evt.target.value = ""; // allow re-selecting the same file next time
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

    el.importCsvBtn.addEventListener("click", () => el.importCsvInput.click());
    el.importCsvInput.addEventListener("change", handleImportFile);
    el.exportCsvBtn.addEventListener("click", exportCSV);
    el.printBtn.addEventListener("click", printResults);
    el.resetVotesBtn.addEventListener("click", resetAllVotes);
    el.refreshBtn.addEventListener("click", () => loadAll());
    el.retryConnectionBtn.addEventListener("click", () => loadAll());

    el.tableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn || isBusy) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "vote") markVoted(id);
      if (action === "undo") undoVote(id);
      if (action === "remarks") editRemarks(id);
      if (action === "edit") openFormForEdit(id);
      if (action === "delete") deleteEngineer(id);
    });
  }

  // ---------- Init ----------
  function init() {
    bindEvents();
    el.year.textContent = new Date().getFullYear();
    tickClock();
    setInterval(tickClock, 1000);
    loadAll({ silent: true });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
