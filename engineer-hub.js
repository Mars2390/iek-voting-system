(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var nav = document.getElementById("eh-nav");
  var burger = document.getElementById("eh-burger");
  var mobileMenu = document.getElementById("eh-mobile-menu");

  function onScroll() {
    if (window.scrollY > 20) {
      nav.classList.add("is-scrolled");
    } else {
      nav.classList.remove("is-scrolled");
    }
    var topBtn = document.getElementById("eh-top");
    if (topBtn) topBtn.classList.toggle("is-visible", window.scrollY > 600);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  function closeMenu() {
    burger.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
    mobileMenu.classList.remove("is-open");
  }

  burger.addEventListener("click", function () {
    var isOpen = mobileMenu.classList.toggle("is-open");
    burger.classList.toggle("is-open", isOpen);
    burger.setAttribute("aria-expanded", String(isOpen));
  });

  mobileMenu.querySelectorAll("a").forEach(function (link) {
    link.addEventListener("click", closeMenu);
  });

  // ---------- Hero carousel ----------
  (function heroCarousel() {
    var hero = document.getElementById("eh-hero");
    if (!hero) return;
    var slides = Array.prototype.slice.call(hero.querySelectorAll(".eh-hero-slide"));
    var dotsWrap = document.getElementById("eh-hero-dots");
    var pauseBtn = document.getElementById("eh-hero-pause");
    if (slides.length < 2) return;

    var current = 0;
    var timer = null;
    var playing = !reduceMotion;
    var INTERVAL = 6000;

    slides.forEach(function (_, i) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "eh-hero-dot" + (i === 0 ? " is-active" : "");
      dot.setAttribute("aria-label", "Show slide " + (i + 1));
      dot.addEventListener("click", function () {
        goTo(i);
        restart();
      });
      dotsWrap.appendChild(dot);
    });
    var dots = Array.prototype.slice.call(dotsWrap.children);

    function goTo(index) {
      slides[current].classList.remove("is-active");
      dots[current].classList.remove("is-active");
      current = (index + slides.length) % slides.length;
      slides[current].classList.add("is-active");
      dots[current].classList.add("is-active");
      var img = slides[current].querySelector("img");
      img.style.animation = "none";
      void img.offsetWidth;
      img.style.animation = "";
    }

    function tick() { goTo(current + 1); }

    function start() {
      if (timer || !playing) return;
      timer = setInterval(tick, INTERVAL);
    }
    function stop() {
      clearInterval(timer);
      timer = null;
    }
    function restart() { stop(); start(); }

    pauseBtn.addEventListener("click", function () {
      playing = !playing;
      pauseBtn.innerHTML = playing
        ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="0.5" /><rect x="7" y="1" width="3" height="10" rx="0.5" /></svg>'
        : '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 1v10l8-5z" /></svg>';
      pauseBtn.setAttribute("aria-label", playing ? "Pause slideshow" : "Play slideshow");
      if (playing) start(); else stop();
    });

    if (!reduceMotion) start();
  })();

  // ---------- Horizontal scroller ----------
  (function scroller() {
    var track = document.getElementById("eh-scroller");
    var prev = document.getElementById("eh-scroll-prev");
    var next = document.getElementById("eh-scroll-next");
    if (!track || !prev || !next) return;

    function step() {
      var card = track.querySelector(".eh-scroll-card");
      return card ? card.getBoundingClientRect().width + 18 : 260;
    }
    function updateButtons() {
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 4;
    }
    prev.addEventListener("click", function () {
      track.scrollBy({ left: -step(), behavior: reduceMotion ? "auto" : "smooth" });
    });
    next.addEventListener("click", function () {
      track.scrollBy({ left: step(), behavior: reduceMotion ? "auto" : "smooth" });
    });
    track.addEventListener("scroll", updateButtons, { passive: true });
    updateButtons();
  })();

  // ---------- Back to top ----------
  var topBtn = document.getElementById("eh-top");
  if (topBtn) {
    topBtn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  }

  // ---------- Scroll reveal ----------
  if ("IntersectionObserver" in window && !reduceMotion) {
    var revealGroups = {};
    document.querySelectorAll(".eh-reveal").forEach(function (el) {
      var key = el.parentElement ? el.parentElement.className : "root";
      revealGroups[key] = revealGroups[key] || [];
      var index = revealGroups[key].length;
      revealGroups[key].push(el);
      el.style.transitionDelay = Math.min(index * 90, 360) + "ms";
    });

    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    document.querySelectorAll(".eh-reveal").forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    document.querySelectorAll(".eh-reveal").forEach(function (el) {
      el.classList.add("is-in");
    });
  }

  // ---------- Smooth anchor scroll ----------
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var id = link.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      var top = target.getBoundingClientRect().top + window.scrollY - 76;
      window.scrollTo({ top: top, behavior: reduceMotion ? "auto" : "smooth" });
    });
  });
})();
