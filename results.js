(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var V = window.HubVote;

  var params = new URLSearchParams(window.location.search);
  var selectEl = document.getElementById("rs-select");
  var loadingEl = document.getElementById("rs-loading");
  var contentEl = document.getElementById("rs-content");
  var boardsEl = document.getElementById("rs-boards");
  var winnerEl = document.getElementById("rs-winner");
  var headEl = document.getElementById("rs-head");
  var updatedEl = document.getElementById("rs-updated");

  // "e:<id>" for an election, "independent" for independent campaigns.
  var scope = params.get("election") ? "e:" + params.get("election") : params.get("scope") === "independent" ? "independent" : null;
  var elections = [];
  var lastPayload = null;
  var pollTimer = null;

  function queryFor(s) {
    return s === "independent" ? { scope: "independent" } : { electionId: s.slice(2) };
  }

  function buildSelector(data) {
    elections = data.elections;
    var opts = elections.map(function (e) { return { value: "e:" + e.id, label: e.title + " — " + V.phaseInfo(e.phase).text }; });
    if (data.independent.liveCount + data.independent.upcomingCount > 0 || !opts.length || scope === "independent") {
      opts.push({ value: "independent", label: "Independent campaigns" });
    }
    if (!scope || !opts.some(function (o) { return o.value === scope; })) scope = opts.length ? opts[0].value : "independent";
    selectEl.innerHTML = opts.map(function (o) { return '<option value="' + o.value + '"' + (o.value === scope ? " selected" : "") + ">" + H.escapeHtml(o.label) + "</option>"; }).join("");
  }
  selectEl.addEventListener("change", function () {
    scope = selectEl.value;
    history.replaceState(null, "", scope === "independent" ? "/results.html?scope=independent" : "/results.html?election=" + scope.slice(2));
    loadingEl.hidden = false;
    contentEl.hidden = true;
    refresh();
  });

  function boardHtml(p) {
    var rows = p.candidates.length
      ? p.candidates.map(function (c, i) {
          return '<div class="vt-row' + (c.isLeader ? " is-leader" : "") + '">' +
            '<span class="vt-rank">' + (i + 1) + "</span>" +
            V.photoHtml(c, "sm") +
            '<div class="vt-row-main"><div class="vt-row-name"><a href="/campaign.html?id=' + c.id + '">' + H.escapeHtml(c.candidateName) + "</a>" +
            (c.isWinner ? '<span class="vt-badge-winner">&#127942; Winner</span>' : c.isTie ? '<span class="vt-badge-tie">Tied lead</span>' : c.isLeader ? '<span class="vt-badge-leader">Leading</span>' : "") +
            (c.phase === "withdrawn" ? '<span class="vt-pill is-closed">Withdrawn</span>' : "") +
            "</div>" +
            '<div class="vt-row-sub">' + H.escapeHtml(c.name) + "</div>" +
            '<div class="vt-bar-track"><div class="vt-bar-fill" style="width:' + c.percent + '%"></div></div></div>' +
            '<div class="vt-row-nums"><span class="votes">' + c.votes + '</span><span class="pct">' + c.percent + "%</span></div>" +
            "</div>";
        }).join("")
      : '<div class="vt-muted" style="padding:14px 0;font-size:14px;">No candidates for this position.</div>';
    return '<section class="hub-card vt-board"><div class="vt-board-head"><h3>' + H.escapeHtml(p.position) + '</h3><span class="sub">' + p.totalVotes + " vote" + (p.totalVotes === 1 ? "" : "s") + "</span></div>" + rows + "</section>";
  }

  function render(d) {
    lastPayload = d;
    V.syncClock(d.serverTime);
    var title = d.election ? d.election.title : "Independent campaigns";
    var sub = d.election ? V.windowLine(d.election) : "Every campaign is its own contest — one vote per engineer per campaign.";
    headEl.innerHTML = "<div><h2>" + H.escapeHtml(title) + "</h2><p>" + H.escapeHtml(sub) + "</p></div>" + V.phasePill(d.phase);
    document.getElementById("rs-total-votes").textContent = d.totalVotes;
    document.getElementById("rs-voters").textContent = d.voterCount;
    document.getElementById("rs-turnout").textContent = d.turnoutPercent + "%";
    document.getElementById("rs-registered").textContent = d.totalEngineers;
    document.getElementById("rs-turnout-bar").style.width = Math.min(100, d.turnoutPercent) + "%";

    if (d.winnersAnnouncedAt) {
      var winners = d.positions.map(function (p) {
        var w = p.candidates.filter(function (c) { return c.isWinner; })[0];
        var tie = p.candidates.filter(function (c) { return c.isTie; });
        return "<strong>" + H.escapeHtml(p.position) + ":</strong> " + (w ? H.escapeHtml(w.candidateName) + " (" + w.votes + " votes)" : tie.length ? "tie between " + tie.map(function (c) { return H.escapeHtml(c.candidateName); }).join(" and ") : "no votes cast");
      });
      winnerEl.innerHTML = '<div class="vt-winner-banner"><h3>&#127942; Results announced ' + H.escapeHtml(V.fmtDateTime(d.winnersAnnouncedAt)) + "</h3><p>" + winners.join(" &nbsp;·&nbsp; ") + "</p></div>";
    } else {
      winnerEl.innerHTML = "";
    }
    boardsEl.innerHTML = d.positions.length ? d.positions.map(boardHtml).join("") : '<div class="hub-empty">No campaigns in this contest yet.</div>';
    updatedEl.textContent = "Updated " + new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + (d.lastVoteAt ? " · last vote " + H.timeAgo(d.lastVoteAt) : "");
    loadingEl.hidden = true;
    contentEl.hidden = false;
  }

  var refreshing = false;
  function refresh() {
    if (refreshing || !scope) return;
    refreshing = true;
    H.api("election-results", { query: queryFor(scope) })
      .then(render)
      .catch(function (err) { loadingEl.textContent = err.message; })
      .finally(function () { refreshing = false; });
  }

  document.getElementById("rs-export").addEventListener("click", function () {
    var q = Object.assign({ action: "election-results", format: "csv" }, queryFor(scope));
    fetch("/api/auth?" + new URLSearchParams(q), { headers: { Authorization: "Bearer " + H.token() } })
      .then(function (r) { if (!r.ok) throw new Error("Export failed"); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "results-" + (lastPayload && lastPayload.election ? lastPayload.election.title : "independent").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".csv";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      })
      .catch(function (err) { H.toast(err.message, true); });
  });

  H.api("elections")
    .then(function (data) {
      buildSelector(data);
      refresh();
      pollTimer = setInterval(function () { if (document.visibilityState === "visible") refresh(); }, 5000);
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); });
      V.pokeDispatcher(3);
    })
    .catch(function (err) { loadingEl.textContent = err.message; });
})();
