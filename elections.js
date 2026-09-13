(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var V = window.HubVote;

  var loadingEl = document.getElementById("vt-loading");
  var contentEl = document.getElementById("vt-content");
  var statusEl = document.getElementById("vt-status");
  var panels = {
    ballot: document.getElementById("vt-panel-ballot"),
    campaigns: document.getElementById("vt-panel-campaigns"),
    results: document.getElementById("vt-panel-results"),
    mine: document.getElementById("vt-panel-mine"),
  };

  var me = null;
  var elections = [];
  var independentSummary = { liveCount: 0, upcomingCount: 0, voteCount: 0 };
  var totalEngineers = 0;
  var currentElection = null;     // the election shown in the status strip + ballot
  var electionBallot = null;      // ballot payload for currentElection
  var independentBallot = null;   // independent campaigns ballot payload
  var allCampaigns = [];
  var myCampaigns = [];
  var currentTab = "ballot";
  var pollTimer = null;
  var countdownTimer = null;

  var params = new URLSearchParams(window.location.search);
  var requestedElectionId = Number(params.get("election")) || null;

  // ---------- Data ----------
  function pickCurrentElection() {
    if (requestedElectionId) {
      var hit = elections.filter(function (e) { return e.id === requestedElectionId; })[0];
      if (hit) return hit;
    }
    return elections.filter(function (e) { return e.phase === "live"; })[0] ||
      elections.filter(function (e) { return e.phase === "upcoming"; })[0] ||
      elections[0] || null;
  }

  function loadAll() {
    return H.api("elections").then(function (data) {
      V.syncClock(data.serverTime);
      elections = data.elections;
      independentSummary = data.independent;
      totalEngineers = data.totalEngineers;
      currentElection = pickCurrentElection();
      return Promise.all([
        currentElection ? H.api("ballot", { query: { electionId: currentElection.id } }) : Promise.resolve(null),
        H.api("ballot"),
        H.api("campaigns", { query: { includeEnded: "0" } }),
        H.api("campaigns", { query: { mine: "1" } }),
      ]);
    }).then(function (results) {
      electionBallot = results[0];
      independentBallot = results[1];
      allCampaigns = results[2].campaigns;
      myCampaigns = results[3].campaigns;
      if (electionBallot) currentElection = electionBallot.election;
    });
  }

  function lookupCampaign(id) {
    var pools = [];
    if (electionBallot) electionBallot.positions.forEach(function (p) { pools = pools.concat(p.candidates); });
    if (independentBallot) independentBallot.positions.forEach(function (p) { pools = pools.concat(p.candidates); });
    pools = pools.concat(allCampaigns);
    return pools.filter(function (c) { return c.id === id; })[0] || null;
  }

  // ---------- Status strip ----------
  function renderStatus() {
    var e = currentElection;
    if (!e) {
      var liveIndep = independentSummary.liveCount;
      statusEl.className = "vt-status is-empty";
      statusEl.innerHTML =
        '<div class="vt-status-row"><div>' +
        '<div class="vt-status-eyebrow">IEK Elections</div>' +
        "<h2>No official election is running right now</h2>" +
        '<div class="vt-status-line">' +
        (liveIndep
          ? "<strong>" + liveIndep + "</strong> independent campaign" + (liveIndep === 1 ? " is" : "s are") + " open for votes below."
          : "Any engineer can launch an independent campaign at any time — be the first.") +
        "</div></div>" +
        '<div class="vt-status-actions"><button type="button" class="eh-btn eh-btn-primary" id="vt-status-create">Launch a campaign</button></div>' +
        "</div>";
      document.getElementById("vt-status-create").addEventListener("click", openCreate);
      return;
    }
    var turnout = totalEngineers ? Math.round((e.voterCount / totalEngineers) * 1000) / 10 : 0;
    var selector = elections.length > 1
      ? '<select id="vt-election-select" class="vt-status-select" aria-label="Choose election">' +
        elections.map(function (x) { return '<option value="' + x.id + '"' + (x.id === e.id ? " selected" : "") + ">" + H.escapeHtml(x.title) + " — " + V.phaseInfo(x.phase).text + "</option>"; }).join("") +
        "</select>"
      : "";
    statusEl.className = "vt-status";
    statusEl.innerHTML =
      '<div class="vt-status-row"><div>' +
      '<div class="vt-status-eyebrow">Official election</div>' +
      "<h2>" + H.escapeHtml(e.title) + "</h2>" +
      '<div class="vt-status-line">' + V.phasePill(e.phase) + ' &nbsp; <span id="vt-status-window">' + H.escapeHtml(V.windowLine(e)) + "</span></div>" +
      (e.description ? '<div class="vt-status-line" style="margin-top:8px;max-width:64ch;">' + H.escapeHtml(e.description) + "</div>" : "") +
      "</div>" +
      '<div class="vt-status-actions">' +
      (e.phase === "live" ? '<button type="button" class="eh-btn eh-btn-primary" id="vt-status-vote">Vote now</button>' : "") +
      '<a class="eh-btn eh-btn-ghost-dark" href="/results.html?election=' + e.id + '">Live results</a>' +
      selector +
      "</div></div>" +
      '<div class="vt-status-stats">' +
      '<div class="vt-status-stat"><span class="num">' + e.candidateCount + '</span><span class="label">Candidate' + (e.candidateCount === 1 ? "" : "s") + "</span></div>" +
      '<div class="vt-status-stat"><span class="num">' + e.positions.length + '</span><span class="label">Position' + (e.positions.length === 1 ? "" : "s") + "</span></div>" +
      '<div class="vt-status-stat"><span class="num">' + e.voterCount + '</span><span class="label">Engineers voted</span></div>' +
      '<div class="vt-status-stat"><span class="num">' + turnout + '%</span><span class="label">Turnout of ' + totalEngineers + "</span></div>" +
      "</div>" +
      '<div class="vt-turnout-track"><div class="vt-turnout-fill" style="width:' + Math.min(100, turnout) + '%"></div></div>';
    var voteBtn = document.getElementById("vt-status-vote");
    if (voteBtn) voteBtn.addEventListener("click", function () { switchTab("ballot"); panels.ballot.scrollIntoView({ behavior: "smooth", block: "start" }); });
    var sel = document.getElementById("vt-election-select");
    if (sel) sel.addEventListener("change", function () {
      requestedElectionId = Number(sel.value);
      history.replaceState(null, "", "/elections.html?election=" + requestedElectionId);
      refresh(true);
    });
  }

  function tickCountdown() {
    var el = document.getElementById("vt-status-window");
    if (el && currentElection) el.textContent = V.windowLine(currentElection);
  }

  // ---------- Ballot ----------
  function positionBlock(p, inElection, phase) {
    var lockedTo = inElection ? p.myVoteCampaignId : null;
    var head =
      '<div class="vt-position-head"><h3>' + H.escapeHtml(p.position) + "</h3>" +
      '<span class="count">' + p.candidates.length + " candidate" + (p.candidates.length === 1 ? "" : "s") + "</span>" +
      (lockedTo ? '<span class="locked"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg> Your vote is in</span>' : "") +
      "</div>";
    var cards = p.candidates.length
      ? '<div class="vt-grid">' + p.candidates.map(function (c) { return V.candidateCard(c, { lockedTo: lockedTo }); }).join("") + "</div>"
      : '<div class="hub-empty" style="padding:22px;">No candidates for this position yet.</div>';
    return head + cards;
  }

  function renderBallot() {
    var html = "";
    if (electionBallot && currentElection) {
      var e = currentElection;
      html += '<div class="vt-section"><div class="vt-section-head"><div><h2>' + H.escapeHtml(e.title) + "</h2>" +
        "<p>" + (e.phase === "live" ? "Pick one candidate per position. Each vote is final." : e.phase === "upcoming" ? "Voting hasn't opened yet — you can read the candidates' manifestos now." : "This election has closed. See the results tab for the outcome.") + "</p></div>" +
        V.phasePill(e.phase) + "</div>";
      html += electionBallot.positions.map(function (p) { return positionBlock(p, true, e.phase); }).join("");
      html += "</div>";
    }
    if (independentBallot && independentBallot.positions.length) {
      html += '<div class="vt-section"><div class="vt-section-head"><div><h2>Independent campaigns</h2>' +
        "<p>Campaigns launched by engineers outside an official election. You can vote once per campaign.</p></div></div>";
      html += independentBallot.positions.map(function (p) { return positionBlock(p, false); }).join("");
      html += "</div>";
    }
    if (!html) {
      html = '<div class="hub-empty"><div class="big">&#128499;&#65039;</div>There\'s nothing on the ballot yet.<br /><br /><button type="button" class="eh-btn eh-btn-primary" id="vt-empty-create">Launch the first campaign</button></div>';
    }
    panels.ballot.innerHTML = html;
    var emptyBtn = document.getElementById("vt-empty-create");
    if (emptyBtn) emptyBtn.addEventListener("click", openCreate);
    V.wireVoteButtons(panels.ballot, lookupCampaign, function () { refresh(true); });
  }

  // ---------- All campaigns ----------
  function renderCampaigns() {
    document.getElementById("vt-tab-campaign-count").textContent = allCampaigns.length ? "(" + allCampaigns.length + ")" : "";
    if (!allCampaigns.length) {
      panels.campaigns.innerHTML = '<div class="hub-empty">No campaigns yet.</div>';
      return;
    }
    var official = allCampaigns.filter(function (c) { return c.electionId; });
    var indep = allCampaigns.filter(function (c) { return !c.electionId; });
    var html = "";
    if (official.length) {
      html += '<div class="vt-section"><div class="vt-section-head"><h2>Official election candidates</h2></div><div class="vt-grid">' +
        official.map(function (c) { return V.candidateCard(c, { compact: false }); }).join("") + "</div></div>";
    }
    if (indep.length) {
      html += '<div class="vt-section"><div class="vt-section-head"><h2>Independent campaigns</h2></div><div class="vt-grid">' +
        indep.map(function (c) { return V.candidateCard(c, { compact: false }); }).join("") + "</div></div>";
    }
    panels.campaigns.innerHTML = html;
    V.wireVoteButtons(panels.campaigns, lookupCampaign, function () { refresh(true); });
  }

  // ---------- Results preview ----------
  function miniBoard(title, data) {
    if (!data || !data.positions.length) return "";
    return data.positions.map(function (p) {
      var top = p.candidates.slice(0, 3);
      var max = top.length ? top[0].votes : 0;
      return '<div class="hub-card vt-result-preview"><h3>' + H.escapeHtml(p.position) + ' <span class="vt-muted" style="font-weight:600;font-size:13px;">· ' + p.totalVotes + " vote" + (p.totalVotes === 1 ? "" : "s") + "</span></h3>" +
        (top.length ? top.map(function (c) {
          return '<div class="vt-mini-row"><span class="name">' + H.escapeHtml(c.candidateName) + (c.isWinner ? ' <span class="vt-badge-winner">Winner</span>' : "") + "</span>" +
            '<span class="track"><span class="fill" style="width:' + (max ? Math.round((c.votes / max) * 100) : 0) + '%"></span></span>' +
            '<span class="n">' + c.votes + "</span></div>";
        }).join("") : '<div class="vt-muted" style="font-size:13.5px;">No candidates yet.</div>') +
        "</div>";
    }).join("");
  }

  function renderResultsPreview() {
    var reqs = [];
    if (currentElection) reqs.push(H.api("election-results", { query: { electionId: currentElection.id } }));
    else reqs.push(Promise.resolve(null));
    reqs.push(H.api("election-results", { query: { scope: "independent" } }));
    Promise.all(reqs).then(function (r) {
      var html = "";
      if (r[0]) {
        html += '<div class="vt-section"><div class="vt-section-head"><div><h2>' + H.escapeHtml(currentElection.title) + "</h2>" +
          "<p>" + r[0].voterCount + " of " + r[0].totalEngineers + " engineers have voted (" + r[0].turnoutPercent + "% turnout).</p></div>" +
          '<a class="eh-btn eh-btn-primary hub-btn-sm" href="/results.html?election=' + currentElection.id + '">Full live results</a></div>' +
          '<div class="vt-grid">' + miniBoard(currentElection.title, r[0]) + "</div></div>";
      }
      if (r[1] && r[1].positions.length) {
        html += '<div class="vt-section"><div class="vt-section-head"><div><h2>Independent campaigns</h2>' +
          "<p>" + r[1].totalVotes + " vote" + (r[1].totalVotes === 1 ? "" : "s") + " cast so far.</p></div>" +
          '<a class="eh-btn eh-btn-ghost-light hub-btn-sm" href="/results.html?scope=independent">Full live results</a></div>' +
          '<div class="vt-grid">' + miniBoard("Independent", r[1]) + "</div></div>";
      }
      panels.results.innerHTML = html || '<div class="hub-empty">No results to show yet.</div>';
    }).catch(function (err) {
      panels.results.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>";
    });
  }

  // ---------- My campaigns ----------
  function renderMine() {
    document.getElementById("vt-tab-mine-count").textContent = myCampaigns.length ? "(" + myCampaigns.length + ")" : "";
    var html = '<div class="vt-section-head"><div><h2>My campaigns</h2><p>Manage your campaign page, send SMS to voters, and track who has voted.</p></div>' +
      '<button type="button" class="eh-btn eh-btn-primary hub-btn-sm" id="vt-mine-create">+ New campaign</button></div>';
    if (!myCampaigns.length) {
      html += '<div class="hub-empty"><div class="big">&#128227;</div>You haven\'t launched a campaign yet.</div>';
    } else {
      html += '<div class="hub-list">' + myCampaigns.map(function (c) {
        return '<div class="hub-card vt-batch" style="border-top:none;padding:16px 18px;">' +
          V.photoHtml(c, "sm") +
          '<div class="vt-batch-main"><div style="font-weight:800;font-size:16px;">' + H.escapeHtml(c.name) + "</div>" +
          '<div class="vt-batch-meta">' + H.escapeHtml(c.position) + (c.electionTitle ? " · " + H.escapeHtml(c.electionTitle) : " · Independent") + " · " + c.votes + " vote" + (c.votes === 1 ? "" : "s") + "</div></div>" +
          V.phasePill(c.phase) + (c.electionId ? " " + V.verifiedBadge(c) : "") +
          '<div class="vt-batch-actions"><a class="eh-btn eh-btn-primary hub-btn-sm" href="/campaign.html?id=' + c.id + '">Manage</a></div>' +
          "</div>";
      }).join("") + "</div>";
    }
    panels.mine.innerHTML = html;
    document.getElementById("vt-mine-create").addEventListener("click", openCreate);
  }

  // ---------- Tabs ----------
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".hub-tab[data-vtab]").forEach(function (t) { t.classList.toggle("is-active", t.dataset.vtab === tab); });
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== tab; });
    if (tab === "results") renderResultsPreview();
  }
  document.querySelectorAll(".hub-tab[data-vtab]").forEach(function (t) {
    t.addEventListener("click", function () { switchTab(t.dataset.vtab); });
  });
  document.getElementById("vt-act-vote").addEventListener("click", function () {
    switchTab("ballot");
    panels.ballot.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("vt-act-create").addEventListener("click", openCreate);

  function openCreate() {
    V.openCampaignForm({
      elections: elections,
      me: me,
      onSaved: function (c) { window.location.href = "/campaign.html?id=" + c.id; },
    });
  }

  // ---------- Render + live refresh ----------
  function renderAll() {
    renderStatus();
    renderBallot();
    renderCampaigns();
    renderMine();
    if (currentTab === "results") renderResultsPreview();
  }

  var refreshing = false;
  function refresh(force) {
    // Never re-render underneath an in-flight vote or an open dialog —
    // the DOM would swap out from under the user mid-action.
    if (V.isBusy() || document.querySelector(".hub-modal-overlay")) return Promise.resolve();
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return loadAll().then(renderAll).catch(function (err) {
      if (force) H.toast(err.message, true);
    }).finally(function () { refreshing = false; });
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.visibilityState === "visible") refresh(false);
    }, 8000);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 30000);
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(false); });

  H.api("me")
    .then(function (d) { me = d.engineer; return loadAll(); })
    .then(function () {
      loadingEl.hidden = true;
      contentEl.hidden = false;
      renderAll();
      startPolling();
      if (params.get("tab") && panels[params.get("tab")]) switchTab(params.get("tab"));
      if (params.get("create") === "1") openCreate();
      // Nudge any due scheduled campaign SMS along (no-op when nothing is due).
      V.pokeDispatcher(3);
    })
    .catch(function (err) {
      loadingEl.textContent = err.message || "Couldn't load the voting section.";
    });
})();
