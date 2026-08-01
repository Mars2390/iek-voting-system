/* =========================================================
   IEK Online Voting System — Application Logic
   Data persistence: localStorage (works fully offline & online)
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_KEY = "iek_voting_engineers_v1";

  /** @type {Array<Object>} */
  let engineers = [];
  let activeFilter = "all"; // all | voted | not-voted

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
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    printBtn: document.getElementById("printBtn"),
    resetVotesBtn: document.getElementById("resetVotesBtn"),
    toast: document.getElementById("toast"),
    statTotal: document.getElementById("statTotal"),
    statVoted: document.getElementById("statVoted"),
    statNotVoted: document.getElementById("statNotVoted"),
    statTurnout: document.getElementById("statTurnout"),
    turnoutBarFill: document.getElementById("turnoutBarFill"),
    clock: document.getElementById("clock"),
    year: document.getElementById("year"),
  };

  // ---------- Utilities ----------
  function uid() {
    return "eng_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

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

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(engineers));
  }

  // ---------- Seed data ----------
  function seedData() {
    const raw = [
      ["Eng. James Ochieng", "IEK001", "0712345678"],
      ["Eng. Mary Wanjiru", "IEK002", "0723456789"],
      ["Eng. Peter Mwangi", "IEK003", "0734567890"],
      ["Eng. Sarah Akinyi", "IEK004", "0745678901"],
      ["Eng. David Odhiambo", "IEK005", "0756789012"],
      ["Eng. Grace Njeri", "IEK006", "0767890123"],
      ["Eng. Michael Otieno", "IEK007", "0778901234"],
      ["Eng. Faith Wambui", "IEK008", "0789012345"],
    ];
    return raw.map(([fullName, iekNumber, phone]) => ({
      id: uid(),
      iekNumber,
      fullName,
      phone,
      status: "not-voted",
      remarks: "",
      votedAt: null,
      dateAdded: new Date().toISOString(),
    }));
  }

  function load() {
    try {
      const rawStored = localStorage.getItem(STORAGE_KEY);
      engineers = rawStored ? JSON.parse(rawStored) : seedData();
    } catch (e) {
      engineers = seedData();
    }
    if (!Array.isArray(engineers) || engineers.length === 0) {
      engineers = seedData();
    }
    save();
  }

  // ---------- Filtering ----------
  function getFiltered() {
    const q = el.searchInput.value.trim().toLowerCase();

    return engineers.filter((e) => {
      const matchesQuery = !q ||
        e.fullName.toLowerCase().includes(q) ||
        e.iekNumber.toLowerCase().includes(q) ||
        e.phone.toLowerCase().includes(q);
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "voted" && e.status === "voted") ||
        (activeFilter === "not-voted" && e.status === "not-voted");
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
        const voted = e.status === "voted";
        const remarks = e.remarks ? escapeHtml(e.remarks) : '<span class="remarks-text empty">No remarks</span>';

        return `
        <tr data-id="${e.id}" class="${voted ? "row-voted" : "row-not-voted"}">
          <td><span class="iek-number">${escapeHtml(e.iekNumber)}</span></td>
          <td>
            <div class="candidate-cell">
              <div class="avatar">${escapeHtml(initials(e.fullName))}</div>
              <span>${escapeHtml(e.fullName)}</span>
            </div>
          </td>
          <td>${escapeHtml(e.phone)}</td>
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

    updateStats();
  }

  function updateStats() {
    const total = engineers.length;
    const voted = engineers.filter((e) => e.status === "voted").length;
    const notVoted = total - voted;
    const turnout = total ? Math.round((voted / total) * 100) : 0;

    el.statTotal.textContent = total;
    el.statVoted.textContent = voted;
    el.statNotVoted.textContent = notVoted;
    el.statTurnout.textContent = `${turnout}%`;
    el.turnoutBarFill.style.width = `${turnout}%`;
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
    const e = engineers.find((x) => x.id === id);
    if (!e) return;
    el.engineerId.value = e.id;
    document.getElementById("iekNumber").value = e.iekNumber;
    document.getElementById("fullName").value = e.fullName;
    document.getElementById("phone").value = e.phone;
    document.getElementById("remarks").value = e.remarks || "";
    el.formTitle.textContent = `Edit Engineer — ${e.fullName}`;
    el.formSubmitBtn.textContent = "Update Engineer";
    el.formPanel.hidden = false;
    document.getElementById("iekNumber").focus();
  }

  function closeForm() {
    el.engineerForm.reset();
    el.engineerId.value = "";
    el.formPanel.hidden = true;
  }

  function submitForm(evt) {
    evt.preventDefault();

    const id = el.engineerId.value;
    const iekNumber = document.getElementById("iekNumber").value.trim();
    const fullName = document.getElementById("fullName").value.trim();
    const phone = document.getElementById("phone").value.trim();
    const remarks = document.getElementById("remarks").value.trim();

    if (!iekNumber || !fullName || !phone) {
      showToast("Please fill in all required fields.", true);
      return;
    }

    const dupe = engineers.some(
      (e) => e.iekNumber.toLowerCase() === iekNumber.toLowerCase() && e.id !== id
    );
    if (dupe) {
      showToast("An engineer with this IEK number already exists.", true);
      return;
    }

    if (id) {
      const e = engineers.find((x) => x.id === id);
      if (!e) return;
      e.iekNumber = iekNumber;
      e.fullName = fullName;
      e.phone = phone;
      e.remarks = remarks;
      showToast(`${fullName} updated successfully.`);
    } else {
      engineers.push({
        id: uid(),
        iekNumber,
        fullName,
        phone,
        remarks,
        status: "not-voted",
        votedAt: null,
        dateAdded: new Date().toISOString(),
      });
      showToast(`${fullName} registered successfully.`);
    }

    save();
    closeForm();
    render();
  }

  // ---------- Actions ----------
  function deleteEngineer(id) {
    const e = engineers.find((x) => x.id === id);
    if (!e) return;
    if (!confirm(`Remove ${e.fullName} (${e.iekNumber}) from the register? This cannot be undone.`)) return;
    engineers = engineers.filter((x) => x.id !== id);
    save();
    render();
    showToast(`${e.fullName} has been removed.`);
  }

  function markVoted(id) {
    const e = engineers.find((x) => x.id === id);
    if (!e) return;
    if (e.status === "voted") return;
    if (!confirm(`Confirm that ${e.fullName} (${e.iekNumber}) has cast their vote?`)) return;
    e.status = "voted";
    e.votedAt = new Date().toISOString();
    save();
    render();
    showToast(`${e.fullName} marked as Voted.`);
  }

  function undoVote(id) {
    const e = engineers.find((x) => x.id === id);
    if (!e) return;
    if (!confirm(`Undo voting status for ${e.fullName} (${e.iekNumber})?`)) return;
    e.status = "not-voted";
    e.votedAt = null;
    save();
    render();
    showToast(`Voting status reverted for ${e.fullName}.`);
  }

  function editRemarks(id) {
    const e = engineers.find((x) => x.id === id);
    if (!e) return;
    const value = prompt(`Remarks for ${e.fullName} (${e.iekNumber}):`, e.remarks || "");
    if (value === null) return;
    e.remarks = value.trim();
    save();
    render();
    showToast("Remarks updated.");
  }

  function resetAllVotes() {
    if (!confirm("Reset ALL voting statuses to 'Not Voted'? This cannot be undone.")) return;
    engineers.forEach((e) => {
      e.status = "not-voted";
      e.votedAt = null;
    });
    save();
    render();
    showToast("All voting statuses have been reset.");
  }

  // ---------- Export / Print ----------
  function exportCSV() {
    if (engineers.length === 0) {
      showToast("No data to export.", true);
      return;
    }
    const headers = ["IEK Number", "Name", "Phone", "Status", "Remarks", "Voted At", "Date Added"];
    const rows = engineers.map((e) => [
      e.iekNumber,
      e.fullName,
      e.phone,
      e.status === "voted" ? "Voted" : "Not Voted",
      e.remarks,
      e.votedAt || "",
      e.dateAdded,
    ]);

    const csvEscape = (val) => {
      const s = String(val ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `IEK_Voting_Results_${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast("Results exported to CSV.");
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

    el.exportCsvBtn.addEventListener("click", exportCSV);
    el.printBtn.addEventListener("click", printResults);
    el.resetVotesBtn.addEventListener("click", resetAllVotes);

    el.tableBody.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-action]");
      if (!btn) return;
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
    load();
    bindEvents();
    el.year.textContent = new Date().getFullYear();
    tickClock();
    setInterval(tickClock, 1000);
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
