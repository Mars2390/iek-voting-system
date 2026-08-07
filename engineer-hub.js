(function () {
  "use strict";

  var nav = document.getElementById("eh-nav");
  var burger = document.getElementById("eh-burger");
  var mobileMenu = document.getElementById("eh-mobile-menu");

  function onScroll() {
    if (window.scrollY > 20) {
      nav.classList.add("is-scrolled");
    } else {
      nav.classList.remove("is-scrolled");
    }
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
})();
