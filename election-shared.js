// Shared Voting helpers used by elections.js, campaign.js, results.js
// and dashboard.js — one implementation of the candidate card, the
// confirm-then-lock vote flow, and the create/edit campaign modal, so
// they can't drift between pages (same rationale as post-shared.js).
// Loaded as a plain global (window.HubVote); no bundler in this project.
window.HubVote = (function () {
  "use strict";
  var H = window.Hub;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fmtDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var h = d.getHours(), ampm = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12;
    var m = String(d.getMinutes()).padStart(2, "0");
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + ", " + h12 + ":" + m + " " + ampm;
  }

  // "2d 4h", "3h 12m", "45m", "under a minute" — for countdowns.
  function fmtDuration(ms) {
    if (ms <= 0) return "now";
    var mins = Math.floor(ms / 60000);
    var days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), rem = mins % 60;
    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + rem + "m";
    if (mins > 0) return mins + "m";
    return "under a minute";
  }

  // The server's clock is the one that decides whether a ballot is
  // accepted, so countdowns are computed against serverTime, not the
  // phone's clock (which can be minutes off).
  var clockOffset = 0;
  function syncClock(serverTimeIso) {
    if (serverTimeIso) clockOffset = new Date(serverTimeIso).getTime() - Date.now();
  }
  function now() { return Date.now() + clockOffset; }

  function phaseInfo(phase) {
    return {
      live: { text: "Voting open", cls: "is-live" },
      upcoming: { text: "Opens soon", cls: "is-upcoming" },
      closed: { text: "Voting closed", cls: "is-closed" },
      ended: { text: "Ended", cls: "is-closed" },
      withdrawn: { text: "Withdrawn", cls: "is-closed" },
      none: { text: "No election", cls: "is-closed" },
    }[phase] || { text: phase || "", cls: "" };
  }
  function phasePill(phase) {
    var p = phaseInfo(phase);
    return '<span class="vt-pill ' + p.cls + '">' + (phase === "live" ? '<span class="vt-live-dot"></span>' : "") + H.escapeHtml(p.text) + "</span>";
  }

  // Countdown line for an election or an independent campaign.
  function windowLine(obj) {
    if (!obj) return "";
    var phase = obj.phase;
    var opens = obj.opensAt || obj.startsAt, closes = obj.closesAt || obj.endsAt;
    if (phase === "upcoming" && opens) return "Voting opens in " + fmtDuration(new Date(opens).getTime() - now()) + " · " + fmtDateTime(opens);
    if (phase === "live" && closes) return "Closes in " + fmtDuration(new Date(closes).getTime() - now()) + " · " + fmtDateTime(closes);
    if (phase === "live") return "Voting is open now";
    if ((phase === "closed" || phase === "ended") && (obj.closedAt || closes)) return "Closed " + fmtDateTime(obj.closedAt || closes);
    return "";
  }

  function firstName(name) {
    var parts = String(name || "").replace(/^(eng\.?|dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?)\s+/i, "").trim().split(/\s+/);
    return parts[0] || "them";
  }

  function photoHtml(c, size) {
    if (c.photoUrl) return '<span class="vt-photo ' + (size || "") + '"><img src="' + H.escapeHtml(c.photoUrl) + '" alt="" /></span>';
    return '<span class="vt-photo ' + (size || "") + ' is-initials">' + H.escapeHtml(H.initials(c.candidateName)) + "</span>";
  }

  function verifiedBadge(c) {
    if (!c.electionId) return "";
    return c.verified
      ? '<span class="vt-verified" title="Verified by the election admin"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>Verified</span>'
      : '<span class="vt-pending">Awaiting verification</span>';
  }

  // Vote-button state for a candidate. `lockedTo` is the campaign id the
  // viewer already chose in this contest (position, for an election).
  function voteButtonHtml(c, lockedTo) {
    if (c.myVoted || (lockedTo && lockedTo === c.id)) {
      return '<span class="vt-voted"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg> You voted for ' + H.escapeHtml(firstName(c.candidateName)) + "</span>";
    }
    if (lockedTo && lockedTo !== c.id) {
      return '<button type="button" class="eh-btn vt-vote-btn is-locked" disabled>Vote locked</button>';
    }
    if (c.canReceiveVotes) {
      return '<button type="button" class="eh-btn eh-btn-primary vt-vote-btn" data-vote="' + c.id + '">Vote for ' + H.escapeHtml(firstName(c.candidateName)) + "</button>";
    }
    if (c.phase === "upcoming") return '<button type="button" class="eh-btn vt-vote-btn is-locked" disabled>Voting opens soon</button>';
    if (c.electionId && !c.verified) return '<button type="button" class="eh-btn vt-vote-btn is-locked" disabled>Awaiting verification</button>';
    return '<button type="button" class="eh-btn vt-vote-btn is-locked" disabled>Voting closed</button>';
  }

  // The candidate card. opts: { lockedTo, showVotes, compact }
  function candidateCard(c, opts) {
    opts = opts || {};
    var bio = c.bio ? H.escapeHtml(c.bio.length > 180 ? c.bio.slice(0, 177).trim() + "…" : c.bio) : '<span class="muted">No manifesto yet.</span>';
    return (
      '<article class="hub-card vt-cand' + (c.myVoted || (opts.lockedTo && opts.lockedTo === c.id) ? " is-mine" : "") + '" data-campaign="' + c.id + '">' +
      '<a class="vt-cand-photo-link" href="/campaign.html?id=' + c.id + '">' + photoHtml(c, "lg") + "</a>" +
      '<div class="vt-cand-body">' +
      '<div class="vt-cand-top">' +
      '<a class="vt-cand-name" href="/campaign.html?id=' + c.id + '">' + H.escapeHtml(c.candidateName) + "</a>" +
      verifiedBadge(c) +
      "</div>" +
      '<div class="vt-cand-campaign">' + H.escapeHtml(c.name) + "</div>" +
      '<div class="vt-cand-meta">' + H.escapeHtml(c.position) + (c.creatorTitle ? " · " + H.escapeHtml(c.creatorTitle) : "") + "</div>" +
      (opts.compact ? "" : '<p class="vt-cand-bio">' + bio + "</p>") +
      '<div class="vt-cand-foot">' +
      (opts.showVotes !== false ? '<span class="vt-cand-votes"><strong data-votes="' + c.id + '">' + c.votes + "</strong> vote" + (c.votes === 1 ? "" : "s") + "</span>" : "") +
      '<a href="/campaign.html?id=' + c.id + '" class="vt-cand-link">View campaign</a>' +
      "</div>" +
      '<div class="vt-cand-action">' + voteButtonHtml(c, opts.lockedTo) + "</div>" +
      "</div></article>"
    );
  }

  // ---------- Vote flow: confirm, then one serialized POST ----------
  // Only one vote request can be in flight per contest (the election
  // position, or the independent campaign itself). A second tap while
  // the first is pending is ignored instead of racing it — two
  // overlapping POSTs to the same position could commit in a different
  // order than their responses return (the exact bug class found in the
  // reactions code), and the server-side unique index would reject the
  // loser anyway; better not to fire it at all.
  var inFlight = {};
  function contestKey(c) { return c.electionId ? "e" + c.electionId + ":" + c.position.toLowerCase() : "c" + c.id; }
  function isBusy() { return Object.keys(inFlight).length > 0; }

  function confirmVote(c) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "hub-modal-overlay hub-confirm-overlay";
      overlay.innerHTML =
        '<div class="hub-confirm vt-confirm" role="alertdialog" aria-modal="true">' +
        photoHtml(c, "md") +
        '<h3 class="hub-confirm-title">Confirm your vote</h3>' +
        '<p class="vt-confirm-who">' + H.escapeHtml(c.candidateName) + "</p>" +
        '<p class="vt-confirm-pos">for <strong>' + H.escapeHtml(c.position) + "</strong>" + (c.electionTitle ? " · " + H.escapeHtml(c.electionTitle) : "") + "</p>" +
        '<p class="hub-confirm-message">Your vote is final — it cannot be changed or cast again once submitted.</p>' +
        '<div class="hub-confirm-actions">' +
        '<button type="button" class="eh-btn eh-btn-ghost-light hub-btn-sm hub-confirm-cancel">Go back</button>' +
        '<button type="button" class="eh-btn eh-btn-save hub-btn-sm hub-confirm-ok">Yes, cast my vote</button>' +
        "</div></div>";
      document.body.appendChild(overlay);
      var prevScroll = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      function finish(v) { document.body.style.overflow = prevScroll; document.removeEventListener("keydown", onKey); overlay.remove(); resolve(v); }
      function onKey(e) { if (e.key === "Escape") finish(false); }
      document.addEventListener("keydown", onKey);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) finish(false); });
      overlay.querySelector(".hub-confirm-cancel").addEventListener("click", function () { finish(false); });
      overlay.querySelector(".hub-confirm-ok").addEventListener("click", function () { finish(true); });
      overlay.querySelector(".hub-confirm-ok").focus();
    });
  }

  // Wires every [data-vote] button inside `scope`. `lookup(id)` returns
  // the campaign object; `onResult({ campaign, votes, myVoteCampaignId,
  // error })` runs after the server answers (success or 409) so the
  // page can re-render from server truth.
  function wireVoteButtons(scope, lookup, onResult) {
    scope.querySelectorAll("[data-vote]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var c = lookup(Number(btn.dataset.vote));
        if (!c) return;
        var key = contestKey(c);
        if (inFlight[key]) return;
        confirmVote(c).then(function (ok) {
          if (!ok) return;
          if (inFlight[key]) return;
          inFlight[key] = true;
          // Disable every vote button in this contest for the duration.
          scope.querySelectorAll("[data-vote]").forEach(function (b) {
            var other = lookup(Number(b.dataset.vote));
            if (other && contestKey(other) === key) { b.disabled = true; b.classList.add("is-sending"); }
          });
          btn.textContent = "Submitting…";
          H.api("vote", { method: "POST", body: { campaignId: c.id } })
            .then(function (data) {
              H.toast("Your vote for " + firstName(c.candidateName) + " has been recorded");
              onResult({ campaign: c, votes: data.campaign.votes, myVoteCampaignId: data.myVoteCampaignId });
            })
            .catch(function (err) {
              H.toast(err.message, true);
              onResult({ campaign: c, error: err.message, myVoteCampaignId: err.data && err.data.myVoteCampaignId });
            })
            .finally(function () { delete inFlight[key]; });
        });
      });
    });
  }

  // ---------- Create / edit campaign modal ----------
  // opts: { campaign (edit) | null (create), elections (open for
  // nominations), me, onSaved(campaign) }
  function toLocalInputValue(iso) {
    var d = iso ? new Date(iso) : new Date(Date.now() + 14 * 86400000);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function openCampaignForm(opts) {
    opts = opts || {};
    var editing = opts.campaign || null;
    var elections = (opts.elections || []).filter(function (e) { return e.nominationsOpen && e.phase !== "closed"; });
    var overlay = document.createElement("div");
    overlay.className = "hub-modal-overlay";
    var contestOptions = '<option value="">Independent campaign (I set my own dates)</option>' +
      elections.map(function (e) { return '<option value="' + e.id + '">' + H.escapeHtml(e.title) + " (official)</option>"; }).join("");
    overlay.innerHTML =
      '<div class="hub-modal pf-form-modal vt-form-modal" role="dialog" aria-modal="true">' +
      '<div class="hub-modal-head"><h3>' + (editing ? "Edit your campaign" : "Launch your campaign") + '</h3><button type="button" class="hub-modal-close" aria-label="Close">&times;</button></div>' +
      '<form class="hub-modal-body pf-form-modal-body vt-form">' +
      '<div class="vt-form-photo-row">' +
      '<span class="vt-form-photo" id="vt-form-photo-preview"></span>' +
      '<div class="vt-form-photo-actions">' +
      '<label class="eh-btn eh-btn-ghost-light hub-btn-sm vt-file-btn">Upload photo<input type="file" id="vt-form-photo-input" accept="image/*" hidden /></label>' +
      '<small>Your profile photo is used until you add a campaign photo.</small>' +
      '<div id="vt-form-photo-status" class="vt-form-photo-status"></div>' +
      "</div></div>" +
      (editing
        ? '<label class="lg-field"><span>Contest</span><input type="text" value="' + H.escapeHtml(editing.electionTitle || "Independent campaign") + '" disabled /></label>'
        : '<label class="lg-field"><span>Contest</span><select id="vt-form-election">' + contestOptions + "</select></label>") +
      '<label class="lg-field" id="vt-form-position-select-wrap" hidden><span>Position</span><select id="vt-form-position-select"></select></label>' +
      '<label class="lg-field" id="vt-form-position-text-wrap"><span>Position you\'re running for</span><input type="text" id="vt-form-position" maxlength="120" placeholder="e.g. Honorary Treasurer" /></label>' +
      '<label class="lg-field"><span>Campaign name</span><input type="text" id="vt-form-name" maxlength="150" placeholder="e.g. Jane for Treasurer — Accountability First" /></label>' +
      '<label class="lg-field"><span>Manifesto / bio</span><textarea id="vt-form-bio" class="pf-form-textarea" rows="5" maxlength="3000" placeholder="Why should fellow engineers vote for you?"></textarea><small><span id="vt-form-bio-count">0</span> / 3000</small></label>' +
      '<label class="lg-field" id="vt-form-ends-wrap"><span>Campaign ends</span><input type="datetime-local" id="vt-form-ends" /><small>Voting for an independent campaign stays open until this time (up to 180 days).</small></label>' +
      '<div id="vt-form-error" class="lg-error" hidden></div>' +
      '<div class="pf-form-actions">' +
      '<button type="submit" class="eh-btn eh-btn-primary pf-form-btn" id="vt-form-submit">' + (editing ? "Save changes" : "Launch campaign") + "</button>" +
      '<button type="button" class="eh-btn eh-btn-ghost-light pf-form-btn" id="vt-form-cancel">Cancel</button>' +
      "</div></form></div>";
    document.body.appendChild(overlay);
    var prevScroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var form = overlay.querySelector("form");
    var electionSel = overlay.querySelector("#vt-form-election");
    var posSelWrap = overlay.querySelector("#vt-form-position-select-wrap");
    var posSel = overlay.querySelector("#vt-form-position-select");
    var posTextWrap = overlay.querySelector("#vt-form-position-text-wrap");
    var posText = overlay.querySelector("#vt-form-position");
    var nameInput = overlay.querySelector("#vt-form-name");
    var bioInput = overlay.querySelector("#vt-form-bio");
    var bioCount = overlay.querySelector("#vt-form-bio-count");
    var endsWrap = overlay.querySelector("#vt-form-ends-wrap");
    var endsInput = overlay.querySelector("#vt-form-ends");
    var errorEl = overlay.querySelector("#vt-form-error");
    var submitBtn = overlay.querySelector("#vt-form-submit");
    var photoPreview = overlay.querySelector("#vt-form-photo-preview");
    var photoStatus = overlay.querySelector("#vt-form-photo-status");
    var photoUrl = editing ? (editing.hasOwnPhoto ? editing.photoUrl : null) : null;
    var uploading = false;

    function renderPhoto() {
      var url = photoUrl || (editing ? editing.photoUrl : opts.me && opts.me.profilePhoto);
      var name = editing ? editing.candidateName : opts.me && opts.me.displayName;
      photoPreview.innerHTML = url ? '<img src="' + H.escapeHtml(url) + '" alt="" />' : H.escapeHtml(H.initials(name || ""));
    }
    renderPhoto();

    function currentElection() {
      if (editing) return editing.electionId ? { id: editing.electionId, positions: null } : null;
      var id = Number(electionSel.value);
      return id ? elections.filter(function (e) { return e.id === id; })[0] : null;
    }
    function syncContest() {
      var e = currentElection();
      var inElection = !!e;
      endsWrap.hidden = inElection;
      if (editing) {
        posSelWrap.hidden = true;
        posTextWrap.hidden = false;
        posText.disabled = inElection || editing.votes > 0;
        return;
      }
      posSelWrap.hidden = !inElection;
      posTextWrap.hidden = inElection;
      if (inElection) posSel.innerHTML = e.positions.map(function (p) { return "<option>" + H.escapeHtml(p) + "</option>"; }).join("");
    }
    if (electionSel) electionSel.addEventListener("change", syncContest);
    syncContest();

    if (editing) {
      posText.value = editing.position;
      nameInput.value = editing.name;
      bioInput.value = editing.bio || "";
      if (!editing.electionId) endsInput.value = toLocalInputValue(editing.endsAt);
    } else {
      endsInput.value = toLocalInputValue(null);
      if (opts.me) nameInput.value = firstName(opts.me.displayName) + " for ";
    }
    bioCount.textContent = String(bioInput.value.length);
    bioInput.addEventListener("input", function () { bioCount.textContent = String(bioInput.value.length); });

    overlay.querySelector("#vt-form-photo-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      uploading = true;
      photoStatus.textContent = "Uploading…";
      H.compressImage(file, 1200, 0.85)
        .then(function (blob) { return H.api("upload-campaign-photo", { method: "POST", body: blob, headers: { "Content-Type": blob.type || file.type || "image/jpeg" } }); })
        .then(function (data) { photoUrl = data.url; photoStatus.textContent = "Photo added"; renderPhoto(); })
        .catch(function (err) { photoStatus.textContent = err.message; })
        .finally(function () { uploading = false; });
    });

    function close() { document.body.style.overflow = prevScroll; document.removeEventListener("keydown", onKey); overlay.remove(); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".hub-modal-close").addEventListener("click", close);
    overlay.querySelector("#vt-form-cancel").addEventListener("click", close);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      if (uploading) { errorEl.textContent = "Wait for the photo to finish uploading."; errorEl.hidden = false; return; }
      var el = currentElection();
      var body = {
        name: nameInput.value.trim(),
        bio: bioInput.value.trim(),
        photoUrl: photoUrl || "",
      };
      if (editing) {
        body.id = editing.id;
        if (!editing.electionId) {
          body.position = posText.value.trim();
          body.endsAt = endsInput.value ? new Date(endsInput.value).toISOString() : "";
        }
      } else {
        if (el) { body.electionId = el.id; body.position = posSel.value; }
        else { body.position = posText.value.trim(); body.endsAt = endsInput.value ? new Date(endsInput.value).toISOString() : ""; }
      }
      submitBtn.disabled = true;
      submitBtn.textContent = editing ? "Saving…" : "Launching…";
      H.api("campaigns", { method: editing ? "PUT" : "POST", body: body })
        .then(function (data) {
          close();
          H.toast(editing ? "Campaign updated" : "Your campaign is live!");
          if (opts.onSaved) opts.onSaved(data.campaign);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = editing ? "Save changes" : "Launch campaign";
        });
    });
    setTimeout(function () { (editing ? nameInput : electionSel || posText).focus(); }, 0);
  }

  // ---------- Share ----------
  function campaignUrl(id) { return window.location.origin + "/campaign.html?id=" + id; }
  function whatsappShareUrl(c) {
    var text = "Please vote for " + c.candidateName + " for " + c.position + " on Engineer Hub: " + campaignUrl(c.id);
    return "https://wa.me/?text=" + encodeURIComponent(text);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  // ---------- Scheduled-SMS dispatcher poke ----------
  // No always-on worker exists in this deployment, so pages nudge the
  // server to process any due campaign SMS batch. Cheap when nothing is
  // due; when something is, keep going until the batch is drained (or
  // we've done a reasonable amount of work for one page visit).
  function pokeDispatcher(maxRounds) {
    var rounds = maxRounds || 6;
    function round() {
      return H.api("campaign-sms-dispatch", { method: "POST" })
        .then(function (d) { if (d.remaining > 0 && --rounds > 0) return round(); return d; })
        .catch(function () {});
    }
    return round();
  }

  return {
    fmtDateTime: fmtDateTime, fmtDuration: fmtDuration, syncClock: syncClock, now: now,
    phaseInfo: phaseInfo, phasePill: phasePill, windowLine: windowLine, firstName: firstName,
    photoHtml: photoHtml, verifiedBadge: verifiedBadge, voteButtonHtml: voteButtonHtml, candidateCard: candidateCard,
    wireVoteButtons: wireVoteButtons, isBusy: isBusy, openCampaignForm: openCampaignForm,
    campaignUrl: campaignUrl, whatsappShareUrl: whatsappShareUrl, copyText: copyText, pokeDispatcher: pokeDispatcher,
  };
})();
