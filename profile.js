(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var params = new URLSearchParams(window.location.search);
  var viewId = params.get("id"); // null => self

  var state = { engineer: null, isSelf: true, connectionStatus: null, connectionId: null, isIncomingRequest: false, experience: [], education: [], skills: [] };

  function fmtDate(d) {
    if (!d) return "";
    var dt = new Date(d);
    return dt.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  }
  function fmtRange(start, end, isCurrent) {
    var s = fmtDate(start) || "—";
    var e = isCurrent ? "Present" : fmtDate(end) || "—";
    return s + " – " + e;
  }

  function load() {
    var query = viewId ? { id: viewId } : {};
    H.api("profile", { query: query })
      .then(function (data) {
        state = data;
        render();
        document.getElementById("pf-loading-wrap").hidden = true;
        document.getElementById("pf-content").hidden = false;
      })
      .catch(function (err) {
        document.getElementById("pf-loading-wrap").innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message || "Couldn't load this profile.") + "</div>";
      });
  }

  function render() {
    var e = state.engineer;
    document.title = (e.displayName || "Profile") + " — Engineer Hub";

    // Cover
    var coverImg = document.getElementById("pf-cover-img");
    if (e.coverPhoto) {
      coverImg.src = e.coverPhoto;
      coverImg.hidden = false;
      coverImg.style.cursor = "pointer";
      coverImg.onclick = function () { H.openLightbox([{ type: "image", url: e.coverPhoto }], 0); };
    } else {
      coverImg.hidden = true;
      coverImg.onclick = null;
    }
    document.getElementById("pf-cover-edit").hidden = !state.isSelf;

    // Avatar
    document.getElementById("pf-avatar").outerHTML = H.avatarHtml(e, "xl").replace('class="hub-avatar', 'id="pf-avatar" class="hub-avatar');
    document.getElementById("pf-avatar-edit").hidden = !state.isSelf;
    if (e.profilePhoto) {
      var avatarEl = document.getElementById("pf-avatar");
      avatarEl.style.cursor = "pointer";
      avatarEl.onclick = function () { H.openLightbox([{ type: "image", url: e.profilePhoto }], 0); };
    }

    document.getElementById("pf-name").textContent = e.displayName;
    document.getElementById("pf-title").textContent = e.title || (state.isSelf ? "Add your title" : "");
    // The membership number is also the login username (see api/auth.js
    // `login`), so it's only ever sent to the profile's own owner — the
    // API omits it entirely for anyone else, and the badge here follows
    // suit rather than printing "undefined".
    document.getElementById("pf-iek-wrap").hidden = !state.isSelf;
    if (state.isSelf) document.getElementById("pf-iek").textContent = e.iekNumber;
    var locCompany = [e.location, e.company].filter(Boolean).join(" · ");
    document.getElementById("pf-location-company").textContent = locCompany;

    var connLink = document.getElementById("pf-connections-count");
    connLink.textContent = state.connectionsCount + " connection" + (state.connectionsCount === 1 ? "" : "s");
    if (state.isSelf) {
      connLink.href = "/connections.html";
    } else {
      connLink.removeAttribute("href");
      connLink.style.cursor = "default";
    }

    var followersLink = document.getElementById("pf-followers-count");
    followersLink.textContent = (state.followersCount || 0) + " follower" + (state.followersCount === 1 ? "" : "s");
    if (state.isSelf) {
      followersLink.href = "/connections.html?tab=followers";
    } else {
      followersLink.removeAttribute("href");
      followersLink.style.cursor = "default";
    }

    document.getElementById("pf-open-to-work-badge").hidden = !e.openToWork;

    var otwRow = document.getElementById("pf-otw-row");
    otwRow.hidden = !state.isSelf;
    if (state.isSelf) document.getElementById("pf-otw-toggle").checked = !!e.openToWork;

    renderHeaderActions();
    renderProfileViews();
    renderAbout();
    renderExperience();
    renderEducation();
    renderSkills();
    renderContact();
    renderDetails();
    renderNudges();

    // "Me" should only read as active when this really is your own
    // profile — browsing someone else's shouldn't light up that tab.
    var meLink = document.querySelector('.db-nav-links a[href="/profile.html"]');
    if (meLink) meLink.classList.toggle("is-active", state.isSelf);
  }

  function renderHeaderActions() {
    var wrap = document.getElementById("pf-header-actions");
    if (state.isSelf) { wrap.innerHTML = ""; return; }
    var status = state.connectionStatus;
    var followBtn = '<button id="pf-follow-btn" class="eh-btn eh-btn-ghost-light hub-btn-sm">' + (state.isFollowing ? "Following ✓" : "+ Follow") + "</button>";
    if (status === "accepted") {
      wrap.innerHTML =
        '<span class="eh-btn eh-btn-ghost-light" style="cursor:default;">Connected ✓</span>' +
        followBtn +
        '<a href="/messages.html?with=' + state.engineer.id + '" class="eh-btn eh-btn-primary hub-btn-sm">Message</a>';
    } else if (status === "pending" && state.isIncomingRequest) {
      wrap.innerHTML =
        '<button id="pf-accept-btn" class="eh-btn eh-btn-primary hub-btn-sm">Accept</button>' +
        '<button id="pf-decline-btn" class="eh-btn eh-btn-ghost-light hub-btn-sm">Decline</button>' +
        followBtn;
      document.getElementById("pf-accept-btn").addEventListener("click", function () { respondConnection("accepted"); });
      document.getElementById("pf-decline-btn").addEventListener("click", function () { respondConnection("declined"); });
    } else if (status === "pending") {
      wrap.innerHTML = '<span class="eh-btn eh-btn-ghost-light" style="cursor:default;">Request pending</span>' + followBtn;
    } else {
      wrap.innerHTML = '<button id="pf-connect-btn" class="eh-btn eh-btn-primary hub-btn-sm">+ Connect</button>' + followBtn;
      document.getElementById("pf-connect-btn").addEventListener("click", sendConnection);
    }
    document.getElementById("pf-follow-btn").addEventListener("click", toggleFollow);
  }

  function sendConnection() {
    H.api("connections", { method: "POST", body: { addresseeId: state.engineer.id } })
      .then(function () { H.toast("Connection request sent"); load(); })
      .catch(function (err) { H.toast(err.message, true); });
  }
  function respondConnection(status) {
    H.api("connections", { method: "PATCH", body: { id: state.connectionId, status: status } })
      .then(function () { H.toast(status === "accepted" ? "Connected!" : "Request declined"); load(); })
      .catch(function (err) { H.toast(err.message, true); });
  }
  function toggleFollow() {
    var wasFollowing = state.isFollowing;
    var req = wasFollowing
      ? H.api("follows", { method: "DELETE", query: { followeeId: state.engineer.id } })
      : H.api("follows", { method: "POST", body: { followeeId: state.engineer.id } });
    req
      .then(function () {
        H.toast(wasFollowing ? "Unfollowed" : "Now following " + state.engineer.displayName);
        state.isFollowing = !wasFollowing;
        state.followersCount = (state.followersCount || 0) + (wasFollowing ? -1 : 1);
        renderHeaderActions();
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  document.getElementById("pf-otw-toggle").addEventListener("change", function () {
    H.api("toggle-open-to-work", { method: "POST" })
      .then(function (data) {
        state.engineer = data.engineer;
        document.getElementById("pf-open-to-work-badge").hidden = !data.engineer.openToWork;
        H.toast(data.engineer.openToWork ? "Marked as open to work" : "No longer marked open to work");
      })
      .catch(function (err) { H.toast(err.message, true); });
  });

  // ---------- Profile completion nudges (self only) ----------
  function renderNudges() {
    var wrap = document.getElementById("pf-nudges");
    if (!state.isSelf) { wrap.hidden = true; return; }
    // Mirrors computeProfileCompletion in api/auth.js field-for-field —
    // that function scores 10 fields into the dashboard's percentage, but
    // used to be checked against a shorter 6-item list here, so the % and
    // the visible "what's missing" list silently disagreed (company,
    // location, discipline, and years of experience counted toward the
    // score with nothing telling the member to go fill them in).
    var e = state.engineer;
    var checks = [
      [!e.bio, "Write a short bio", "#pf-about-edit-btn"],
      [!e.title, "Add your job title", "#pf-details-edit-btn"],
      [!e.company, "Add your company", "#pf-details-edit-btn"],
      [!e.location, "Add your location", "#pf-details-edit-btn"],
      [!e.discipline, "Add your engineering discipline", "#pf-details-edit-btn"],
      [!e.experienceYears, "Add your years of experience", "#pf-details-edit-btn"],
      [!e.profilePhoto, "Add a profile photo", "#pf-avatar-edit"],
      [!state.experience.length, "Add your work experience", "#pf-exp-add-btn"],
      [!state.education.length, "Add your education", "#pf-edu-add-btn"],
      [!state.skills.length, "Add at least one skill", null],
    ];
    var missing = checks.filter(function (c) { return c[0]; });
    if (!missing.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.innerHTML =
      "<h3>Complete your profile</h3><ul>" +
      missing
        .map(function (c) {
          return c[2] ? '<li><a href="' + c[2] + '" data-nudge>' + c[1] + "</a></li>" : "<li>" + c[1] + "</li>";
        })
        .join("") +
      "</ul>";
    wrap.querySelectorAll("[data-nudge]").forEach(function (a) {
      a.addEventListener("click", function (e2) {
        e2.preventDefault();
        var target = document.querySelector(a.getAttribute("href"));
        if (target) target.click();
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  // ---------- Profile views (self only) ----------
  function renderProfileViews() {
    var card = document.getElementById("pf-views-card");
    if (!state.isSelf) { card.hidden = true; return; }
    card.hidden = false;
    document.getElementById("pf-views-count").textContent = state.profileViewsCount || 0;
    var list = document.getElementById("pf-views-list");
    var viewers = state.profileViewers || [];
    if (!viewers.length) {
      list.innerHTML = '<div class="hub-empty" style="padding:4px 0;">No one has viewed your profile yet.</div>';
      return;
    }
    list.innerHTML = viewers
      .map(function (v) {
        var role = [v.title, v.company].filter(Boolean).join(" at ");
        return (
          '<a href="/profile.html?id=' + v.id + '" class="pf-views-item" style="color:inherit;">' +
          H.avatarHtml({ displayName: v.displayName, profilePhoto: v.profilePhoto }, "sm") +
          '<div class="info"><h4>' + H.escapeHtml(v.displayName) + "</h4>" +
          (role ? "<p>" + H.escapeHtml(role) + "</p>" : "") +
          "</div>" +
          "<time>" + H.timeAgo(v.viewedAt) + "</time>" +
          "</a>"
        );
      })
      .join("");
  }

  // ---------- About ----------
  function renderAbout() {
    var view = document.getElementById("pf-bio-view");
    var editBtn = document.getElementById("pf-about-edit-btn");
    editBtn.hidden = !state.isSelf;
    if (state.engineer.bio) {
      view.textContent = state.engineer.bio;
      view.classList.remove("is-empty");
    } else {
      view.textContent = state.isSelf ? "Add a short professional summary." : "No bio yet.";
      view.classList.add("is-empty");
    }
  }
  document.getElementById("pf-about-edit-btn").addEventListener("click", function () {
    document.getElementById("pf-input-bio").value = state.engineer.bio || "";
    toggleForm("pf-bio-view", "pf-about-form", true);
  });
  document.getElementById("pf-about-form").addEventListener("submit", function (e) {
    e.preventDefault();
    saveProfileFields({ bio: document.getElementById("pf-input-bio").value.trim() }, function () {
      toggleForm("pf-bio-view", "pf-about-form", false);
    });
  });

  function toggleForm(viewId2, formId, showForm) {
    document.getElementById(viewId2).hidden = showForm;
    document.getElementById(formId).hidden = !showForm;
  }
  document.querySelectorAll(".pf-cancel").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var form = btn.closest("form");
      form.hidden = true;
      var view = form.previousElementSibling;
      if (view) view.hidden = false;
      form.classList.remove("is-editing-entry");
    });
  });

  function saveProfileFields(fields, onDone) {
    var body = Object.assign(
      {
        displayName: state.engineer.displayName,
        discipline: state.engineer.discipline,
        company: state.engineer.company,
        title: state.engineer.title,
        location: state.engineer.location,
        bio: state.engineer.bio,
        email: state.engineer.email,
        linkedinUrl: state.engineer.linkedinUrl,
        githubUrl: state.engineer.githubUrl,
        portfolioUrl: state.engineer.portfolioUrl,
        experienceYears: state.engineer.experienceYears,
      },
      fields
    );
    H.api("update-profile", { method: "POST", body: body })
      .then(function (data) {
        state.engineer = data.engineer;
        render();
        H.toast("Saved");
        if (onDone) onDone();
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  // ---------- Experience ----------
  function renderExperience() {
    document.getElementById("pf-exp-add-btn").hidden = !state.isSelf;
    var list = document.getElementById("pf-exp-list");
    if (!state.experience.length) {
      list.innerHTML = '<div class="hub-empty" style="padding:16px 0;">No experience added yet.</div>';
    } else {
      list.innerHTML = state.experience
        .map(function (x) {
          return (
            '<div class="pf-entry" data-id="' + x.id + '">' +
            "<div>" +
            "<h4>" + H.escapeHtml(x.job_title) + "</h4>" +
            '<p class="sub">' + H.escapeHtml(x.company_name) + "</p>" +
            '<p class="dates">' + fmtRange(x.start_date, x.end_date, x.is_current) + "</p>" +
            (x.description ? '<p class="desc">' + H.escapeHtml(x.description) + "</p>" : "") +
            "</div>" +
            (state.isSelf
              ? '<div class="pf-entry-actions"><button data-edit>Edit</button><button data-del>Delete</button></div>'
              : "") +
            "</div>"
          );
        })
        .join("");
      if (state.isSelf) {
        list.querySelectorAll("[data-edit]").forEach(function (b) {
          b.addEventListener("click", function () { editExperience(Number(b.closest(".pf-entry").dataset.id)); });
        });
        list.querySelectorAll("[data-del]").forEach(function (b) {
          b.addEventListener("click", function () { deleteEntry("work-experience", Number(b.closest(".pf-entry").dataset.id)); });
        });
      }
    }
  }
  document.getElementById("pf-exp-add-btn").addEventListener("click", function () {
    document.getElementById("pf-exp-form").reset();
    document.getElementById("pf-exp-id").value = "";
    document.getElementById("pf-exp-form").hidden = false;
  });
  function editExperience(id) {
    var x = state.experience.find(function (r) { return r.id === id; });
    if (!x) return;
    document.getElementById("pf-exp-id").value = x.id;
    document.getElementById("pf-exp-title").value = x.job_title;
    document.getElementById("pf-exp-company").value = x.company_name;
    document.getElementById("pf-exp-start").value = x.start_date ? x.start_date.slice(0, 10) : "";
    document.getElementById("pf-exp-end").value = x.end_date ? x.end_date.slice(0, 10) : "";
    document.getElementById("pf-exp-current").checked = x.is_current;
    document.getElementById("pf-exp-desc").value = x.description || "";
    document.getElementById("pf-exp-form").hidden = false;
  }
  document.getElementById("pf-exp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var id = document.getElementById("pf-exp-id").value;
    var body = {
      jobTitle: document.getElementById("pf-exp-title").value.trim(),
      companyName: document.getElementById("pf-exp-company").value.trim(),
      startDate: document.getElementById("pf-exp-start").value || null,
      endDate: document.getElementById("pf-exp-end").value || null,
      isCurrent: document.getElementById("pf-exp-current").checked,
      description: document.getElementById("pf-exp-desc").value.trim(),
    };
    if (id) body.id = Number(id);
    H.api("work-experience", { method: id ? "PUT" : "POST", body: body })
      .then(function () { return H.api("work-experience", { query: { engineerId: state.engineer.id } }); })
      .then(function (data) {
        state.experience = data.experience;
        renderExperience();
        document.getElementById("pf-exp-form").hidden = true;
        H.toast("Saved");
      })
      .catch(function (err) { H.toast(err.message, true); });
  });

  // ---------- Education ----------
  function renderEducation() {
    document.getElementById("pf-edu-add-btn").hidden = !state.isSelf;
    var list = document.getElementById("pf-edu-list");
    if (!state.education.length) {
      list.innerHTML = '<div class="hub-empty" style="padding:16px 0;">No education added yet.</div>';
    } else {
      list.innerHTML = state.education
        .map(function (x) {
          return (
            '<div class="pf-entry" data-id="' + x.id + '">' +
            "<div>" +
            "<h4>" + H.escapeHtml(x.institution) + "</h4>" +
            '<p class="sub">' + H.escapeHtml(x.degree) + (x.field_of_study ? ", " + H.escapeHtml(x.field_of_study) : "") + "</p>" +
            '<p class="dates">' + (x.start_year || "—") + " – " + (x.end_year || "—") + "</p>" +
            "</div>" +
            (state.isSelf
              ? '<div class="pf-entry-actions"><button data-edit>Edit</button><button data-del>Delete</button></div>'
              : "") +
            "</div>"
          );
        })
        .join("");
      if (state.isSelf) {
        list.querySelectorAll("[data-edit]").forEach(function (b) {
          b.addEventListener("click", function () { editEducation(Number(b.closest(".pf-entry").dataset.id)); });
        });
        list.querySelectorAll("[data-del]").forEach(function (b) {
          b.addEventListener("click", function () { deleteEntry("education", Number(b.closest(".pf-entry").dataset.id)); });
        });
      }
    }
  }
  document.getElementById("pf-edu-add-btn").addEventListener("click", function () {
    document.getElementById("pf-edu-form").reset();
    document.getElementById("pf-edu-id").value = "";
    document.getElementById("pf-edu-form").hidden = false;
  });
  function editEducation(id) {
    var x = state.education.find(function (r) { return r.id === id; });
    if (!x) return;
    document.getElementById("pf-edu-id").value = x.id;
    document.getElementById("pf-edu-institution").value = x.institution;
    document.getElementById("pf-edu-degree").value = x.degree;
    document.getElementById("pf-edu-field").value = x.field_of_study || "";
    document.getElementById("pf-edu-start").value = x.start_year || "";
    document.getElementById("pf-edu-end").value = x.end_year || "";
    document.getElementById("pf-edu-form").hidden = false;
  }
  document.getElementById("pf-edu-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var id = document.getElementById("pf-edu-id").value;
    var body = {
      institution: document.getElementById("pf-edu-institution").value.trim(),
      degree: document.getElementById("pf-edu-degree").value.trim(),
      fieldOfStudy: document.getElementById("pf-edu-field").value.trim(),
      startYear: Number(document.getElementById("pf-edu-start").value) || null,
      endYear: Number(document.getElementById("pf-edu-end").value) || null,
    };
    if (id) body.id = Number(id);
    H.api("education", { method: id ? "PUT" : "POST", body: body })
      .then(function () { return H.api("education", { query: { engineerId: state.engineer.id } }); })
      .then(function (data) {
        state.education = data.education;
        renderEducation();
        document.getElementById("pf-edu-form").hidden = true;
        H.toast("Saved");
      })
      .catch(function (err) { H.toast(err.message, true); });
  });

  function deleteEntry(action, id) {
    H.confirm({ message: "This entry will be removed from your profile." }).then(function (ok) {
      if (!ok) return;
      H.api(action, { method: "DELETE", query: { id: id } })
        .then(function () { return H.api(action, { query: { engineerId: state.engineer.id } }); })
        .then(function (data) {
          if (action === "work-experience") { state.experience = data.experience; renderExperience(); }
          else { state.education = data.education; renderEducation(); }
        })
        .catch(function (err) { H.toast(err.message, true); });
    });
  }

  // ---------- Skills ----------
  function renderSkills() {
    var list = document.getElementById("pf-skills-list");
    var form = document.getElementById("pf-skill-form");
    form.classList.toggle("is-open", state.isSelf);
    if (!state.skills.length) {
      list.innerHTML = state.isSelf ? "" : '<div class="hub-empty" style="padding:8px 0;">No skills listed.</div>';
    } else {
      list.innerHTML = state.skills
        .map(function (s) {
          return (
            '<span class="hub-tag' + (state.isSelf ? " removable" : "") + '" data-id="' + s.id + '">' +
            H.escapeHtml(s.skill_name) +
            (state.isSelf ? ' <span class="rm" data-rm="' + s.id + '">&times;</span>' : "") +
            "</span>"
          );
        })
        .join("");
      if (state.isSelf) {
        list.querySelectorAll("[data-rm]").forEach(function (el) {
          el.addEventListener("click", function () {
            H.api("skills", { method: "DELETE", query: { id: el.dataset.rm } })
              .then(function () { return H.api("skills", { query: { engineerId: state.engineer.id } }); })
              .then(function (data) { state.skills = data.skills; renderSkills(); })
              .catch(function (err) { H.toast(err.message, true); });
          });
        });
      }
    }
  }
  document.getElementById("pf-skill-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("pf-skill-input");
    var name = input.value.trim();
    if (!name) return;
    H.api("skills", { method: "POST", body: { skillName: name } })
      .then(function () { return H.api("skills", { query: { engineerId: state.engineer.id } }); })
      .then(function (data) {
        state.skills = data.skills;
        renderSkills();
        input.value = "";
      })
      .catch(function (err) { H.toast(err.message, true); });
  });

  // ---------- Contact ----------
  function renderContact() {
    var e = state.engineer;
    document.getElementById("pf-contact-edit-btn").hidden = !state.isSelf;
    var rows = [];
    if (state.isSelf) rows.push(["Phone", e.phone || "Not on file"]);
    rows.push(["Email", e.email ? '<a href="mailto:' + H.escapeHtml(e.email) + '">' + H.escapeHtml(e.email) + "</a>" : "—"]);
    rows.push(["LinkedIn", e.linkedinUrl ? '<a href="' + H.escapeHtml(e.linkedinUrl) + '" target="_blank" rel="noopener">View</a>' : "—"]);
    rows.push(["GitHub", e.githubUrl ? '<a href="' + H.escapeHtml(e.githubUrl) + '" target="_blank" rel="noopener">View</a>' : "—"]);
    rows.push(["Portfolio", e.portfolioUrl ? '<a href="' + H.escapeHtml(e.portfolioUrl) + '" target="_blank" rel="noopener">View</a>' : "—"]);
    document.getElementById("pf-contact-view").innerHTML = rows.map(function (r) { return '<div class="row"><dt>' + r[0] + "</dt><dd>" + r[1] + "</dd></div>"; }).join("");
  }
  document.getElementById("pf-contact-edit-btn").addEventListener("click", function () {
    var e = state.engineer;
    document.getElementById("pf-input-email").value = e.email || "";
    document.getElementById("pf-input-linkedin").value = e.linkedinUrl || "";
    document.getElementById("pf-input-github").value = e.githubUrl || "";
    document.getElementById("pf-input-portfolio").value = e.portfolioUrl || "";
    toggleForm("pf-contact-view", "pf-contact-form", true);
  });
  document.getElementById("pf-contact-form").addEventListener("submit", function (e) {
    e.preventDefault();
    saveProfileFields(
      {
        email: document.getElementById("pf-input-email").value.trim(),
        linkedinUrl: document.getElementById("pf-input-linkedin").value.trim(),
        githubUrl: document.getElementById("pf-input-github").value.trim(),
        portfolioUrl: document.getElementById("pf-input-portfolio").value.trim(),
      },
      function () { toggleForm("pf-contact-view", "pf-contact-form", false); }
    );
  });

  // ---------- Details ----------
  function renderDetails() {
    var e = state.engineer;
    document.getElementById("pf-details-edit-btn").hidden = !state.isSelf;
    // A manually-typed experience number is easy to leave blank/zero even
    // after adding real job history in the Experience section below — so
    // an empty/zero manual value falls back to a figure computed from
    // that history instead of just printing "0 yrs".
    var years = e.experienceYears || state.experienceYearsFromHistory;
    var yearsLabel = years != null ? years + " yrs" + (!e.experienceYears && state.experienceYearsFromHistory ? " (from work history)" : "") : "—";
    var rows = [
      ["Discipline", e.discipline || "—"],
      ["Company", e.company || "—"],
      ["Location", e.location || "—"],
      ["Experience", yearsLabel],
    ];
    document.getElementById("pf-details-view").innerHTML = rows.map(function (r) { return '<div class="row"><dt>' + r[0] + "</dt><dd>" + H.escapeHtml(r[1]) + "</dd></div>"; }).join("");
  }
  document.getElementById("pf-details-edit-btn").addEventListener("click", function () {
    var e = state.engineer;
    document.getElementById("pf-input-name").value = e.displayName || "";
    document.getElementById("pf-input-title").value = e.title || "";
    document.getElementById("pf-input-discipline").value = e.discipline || "";
    document.getElementById("pf-input-company").value = e.company || "";
    document.getElementById("pf-input-location").value = e.location || "";
    document.getElementById("pf-input-years").value = e.experienceYears != null ? e.experienceYears : "";
    toggleForm("pf-details-view", "pf-details-form", true);
  });
  document.getElementById("pf-details-form").addEventListener("submit", function (e) {
    e.preventDefault();
    saveProfileFields(
      {
        displayName: document.getElementById("pf-input-name").value.trim(),
        title: document.getElementById("pf-input-title").value.trim(),
        discipline: document.getElementById("pf-input-discipline").value.trim(),
        company: document.getElementById("pf-input-company").value.trim(),
        location: document.getElementById("pf-input-location").value.trim(),
        experienceYears: document.getElementById("pf-input-years").value ? Number(document.getElementById("pf-input-years").value) : null,
      },
      function () { toggleForm("pf-details-view", "pf-details-form", false); }
    );
  });

  // ---------- Photo uploads ----------
  // Compress before the size check, not after — phone camera photos
  // routinely start at 3-15MB, well over the 5MB cap, and used to be
  // rejected outright before compression even ran. Compression brings
  // real-world photos down to a few hundred KB, so the post-compression
  // check almost never fires; it's just a safety net.
  function wireUpload(btnId, inputId, kind) {
    var btn = document.getElementById(btnId);
    var originalLabel = btn.innerHTML;
    document.getElementById(btnId).addEventListener("click", function () { document.getElementById(inputId).click(); });
    document.getElementById(inputId).addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      btn.disabled = true;
      var busyLabel = kind === "cover" ? "Uploading…" : "";
      if (kind === "cover") btn.textContent = busyLabel;
      else btn.style.opacity = "0.5";

      H.compressImage(file, kind === "cover" ? 1920 : 800, 0.82)
        .then(function (compressed) {
          if (compressed.size > 5 * 1024 * 1024) throw new Error("Image is still too large after compression — try a different photo.");
          return H.api("upload-photo", { method: "POST", query: { kind: kind }, headers: { "Content-Type": compressed.type || "image/jpeg" }, body: compressed });
        })
        .then(function (data) {
          state.engineer = data.engineer;
          render();
          H.toast((kind === "cover" ? "Cover" : "Profile") + " photo updated");
        })
        .catch(function (err) { H.toast(err.message, true); })
        .finally(function () {
          btn.disabled = false;
          btn.style.opacity = "";
          if (kind === "cover") btn.textContent = originalLabel;
          e.target.value = "";
        });
    });
  }
  wireUpload("pf-cover-edit", "pf-cover-input", "cover");
  wireUpload("pf-avatar-edit", "pf-avatar-input", "profile");

  load();
})();
