/* ============================================================
   TACOA GENERAL TRADING — main.js
   Handles: navbar scroll, mobile menu, scroll animations,
            stat counters, active nav link
   ============================================================ */

(function () {
  'use strict';

  /* ── Navbar Scroll Behaviour ──────────────────────────────── */
  const navbar = document.getElementById('navbar');
  if (navbar) {
    function updateNavbar() {
      if (window.scrollY > 60) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    }
    window.addEventListener('scroll', updateNavbar, { passive: true });
    updateNavbar();
  }

  /* ── Mobile Menu ──────────────────────────────────────────── */
  const hamburger     = document.getElementById('hamburger');
  const mobileNav     = document.getElementById('mobileNav');
  const mobileOverlay = document.getElementById('mobileOverlay');

  function openMobileNav() {
    mobileNav.classList.add('open');
    mobileOverlay.classList.add('open');
    hamburger.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeMobileNav() {
    mobileNav.classList.remove('open');
    mobileOverlay.classList.remove('open');
    hamburger.classList.remove('open');
    document.body.style.overflow = '';
  }

  if (hamburger) {
    hamburger.addEventListener('click', function () {
      if (mobileNav.classList.contains('open')) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });
  }

  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', closeMobileNav);
  }

  // Close mobile nav when a link is clicked
  if (mobileNav) {
    mobileNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMobileNav);
    });
  }

  /* ── Active Nav Link ──────────────────────────────────────── */
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(function (link) {
    const href = (link.getAttribute('href') || '').split('#')[0];
    if (href === currentPath) {
      link.classList.add('active');
    } else if (currentPath === '' && href === 'index.html') {
      link.classList.add('active');
    }
  });

  /* ── Scroll Animations (Intersection Observer) ────────────── */
  const fadeEls = document.querySelectorAll('.fade-up');
  if (fadeEls.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    fadeEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: show all immediately
    fadeEls.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  /* ── Stat Counter Animation ───────────────────────────────── */
  function animateCount(el, target, duration) {
    var start     = 0;
    var increment = target / (duration / 16);
    var plus      = el.querySelector('.plus');
    var plusText  = plus ? plus.outerHTML : '';

    function step() {
      start += increment;
      if (start >= target) {
        el.innerHTML = target + plusText;
        return;
      }
      el.innerHTML = Math.floor(start) + plusText;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var statNums = document.querySelectorAll('.stats-num[data-target]');
  if (statNums.length && 'IntersectionObserver' in window) {
    var statsObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var el     = entry.target;
            var target = parseInt(el.getAttribute('data-target'), 10);
            animateCount(el, target, 1400);
            statsObserver.unobserve(el);
          }
        });
      },
      { threshold: 0.5 }
    );
    statNums.forEach(function (el) {
      statsObserver.observe(el);
    });
  }

  /* ── Smooth Scroll for anchor links ──────────────────────── */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var id = this.getAttribute('href');
      if (id === '#') return;
      var target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        var offset = 80; // navbar height
        var top    = target.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top: top, behavior: 'smooth' });
      }
    });
  });

  /* ── Products Filter Buttons (visual only) ────────────────── */
  document.querySelectorAll('.filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.filter-btn').forEach(function (b) {
        b.classList.remove('active');
      });
      this.classList.add('active');
    });
  });

  /* ── Newsletter Form ──────────────────────────────────────── */
  document.querySelectorAll('.newsletter-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('.newsletter-input');
      var btn   = form.querySelector('.newsletter-btn');
      if (input && input.value.trim()) {
        btn.textContent  = 'Subscribed!';
        btn.style.background = '#27ae60';
        input.value = '';
        setTimeout(function () {
          btn.textContent  = 'Subscribe';
          btn.style.background = '';
        }, 3000);
      }
    });
  });

})();
