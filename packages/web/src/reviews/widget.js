/**
 * Google Reviews slider: dependency-free behaviour layer, scoped to `.gr-reviews`.
 *
 * Copied from the `review-collector` project, where `build-widget.js` bundles this file with
 * `widget.css` and a JSON payload into a self-contained embed snippet. The slider logic is unchanged;
 * only the module wrapper differs, so a React page can mount it (see `ReviewsSlider.jsx`):
 *
 *   - the IIFE wrapper is gone and `init` is exported as `initReviewsSlider`;
 *   - `"use strict"` is implicit in ES modules;
 *   - the auto-boot is kept for server-rendered pages but is inert when nothing matches yet.
 *
 * Everything else — the scroll-driven 3D fan, autoplay, lightbox, keyboard and pointer handling, and
 * the layout fit pass — is the developed component as-is. Theming is done through the custom
 * properties documented in the collector README; see `reviewsSlider.css` for the site's overrides.
 */


var SVG_NS = "http://www.w3.org/2000/svg";
var CLAMP_AT = 240;
var AUTOPLAY_MS = 6500;

var ICONS = {
  star: "M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z",
  arrowLeft: "M15 5l-7 7 7 7",
  arrowRight: "M9 5l7 7-7 7",
  close: "M6 6l12 12M18 6L6 18",
  external: "M7 17L17 7M9 7h8v8",
  pause: "M9 5v14M15 5v14",
  play: "M8 5l11 7-11 7z",
  meal: "M7 3v8a2 2 0 004 0V3M9 11v10M17 3c-1.5 2-2 3.5-2 6s.5 3 2 3v9",
  price: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 3 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3",
  clock: "M12 7v5l3.5 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  noise: "M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4",
  check: "M4 12.5l5 5L20 6.5"
};

var GOOGLE_G =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
  '<path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 2-1.5 5-4.4 7l-.1.3 6.4 4.9.4.1c4-3.7 6.7-9.2 6.7-15.6"/>' +
  '<path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.3c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-.3.1-6.6 5.1-.1.3C8.1 41 15.4 46 24 46"/>' +
  '<path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.7-4.5v-.3L4.7 14l-.2.1A22 22 0 002 24c0 3.5.9 6.9 2.5 9.9z"/>' +
  '<path fill="#EA4335" d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.2 29.9 2 24 2 15.4 2 8.1 7 4.5 14.1l7 5.4c1.8-5.3 6.7-9.1 12.5-9.1"/>' +
  "</svg>";

/* ------------------------------------------------------------- helpers */

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name, cls) {
  var svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  var path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.9");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function stars(value, large) {
  var wrap = el("span", "gr-stars" + (large ? " gr-stars--lg" : ""));
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", value + " out of 5 stars");
  for (var i = 1; i <= 5; i++) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "gr-star" + (i <= Math.round(value) ? " is-on" : ""));
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS.star);
    svg.appendChild(path);
    wrap.appendChild(svg);
  }
  return wrap;
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(function (part) {
      return part.charAt(0).toUpperCase();
    })
    .join("");
}

function hue(name) {
  var h = 0;
  for (var i = 0; i < (name || "").length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return h;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/[\u2026]+$/, "").trim() : "";
}

/**
 * Builds a <picture> with AVIF/WebP/JPEG sources so the browser picks the
 * smallest format it supports. `size` is "thumb" or "full".
 */
function picture(image, size) {
  var set = image[size] || image.thumb || image.full || {};
  var wrap = document.createElement("picture");

  ["avif", "webp"].forEach(function (format) {
    if (!set[format]) return;
    var source = document.createElement("source");
    source.type = "image/" + format;
    source.srcset = set[format];
    wrap.appendChild(source);
  });

  var img = document.createElement("img");
  img.src = set.jpg || set.webp || set.avif || "";
  img.alt = image.alt || "";
  img.loading = "lazy";
  img.decoding = "async";
  if (image.width && image.height) {
    img.width = image.width;
    img.height = image.height;
  }
  wrap.appendChild(img);
  return wrap;
}

function prefersReducedMotion() {
  return (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ---------------------------------------------------------------- card */

// Assigned by init() once the card list exists; buildCard's handlers call it.
var requestFit = function () {};

function buildCard(review, index, onPhoto) {
  // The outer element is the scroll-snap target and must stay untransformed,
  // otherwise the browser snaps to the transformed box and the carousel
  // drifts off-centre. All 3D movement happens on the inner element.
  var card = el("article", "gr-card");
  card.setAttribute("role", "group");
  card.setAttribute("aria-roledescription", "slide");

  var inner = el("div", "gr-card__inner");
  card.appendChild(inner);

  var top = el("div", "gr-card__top");
  top.appendChild(stars(review.stars || 5));
  if (review.relativeDate) {
    top.appendChild(el("span", "gr-card__date", review.relativeDate));
  }
  inner.appendChild(top);

  var comment = (review.comment || "").trim();
  if (comment) {
    // Quote and its toggle live in one block so the fit pass can centre the
    // whole thing when there is no gallery to fill the card. The curly
    // quotes are drawn by CSS so a short review can enlarge them.
    var body = el("div", "gr-card__body");
    var quote = el("p", "gr-card__quote", comment);
    body.appendChild(quote);

    // Always rendered so the fit pass can reveal it whenever it has to
    // clamp, even for comments shorter than CLAMP_AT on a short viewport.
    var more = el("button", "gr-card__more", "Read more");
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.hidden = comment.length <= CLAMP_AT;
    body.appendChild(more);
    inner.appendChild(body);

    // The layout pass decides how many lines fit and sets --gr-clamp.
    // Expanding is a user intent, so it is recorded and the fit pass
    // leaves the quote alone until it is collapsed again.
    more.addEventListener("click", function () {
      var clamped = quote.classList.toggle("is-clamped");
      quote.dataset.expanded = clamped ? "0" : "1";
      more.textContent = clamped ? "Read more" : "Show less";
      more.setAttribute("aria-expanded", String(!clamped));
      requestFit();
    });
  }

  var photos = (review.images || []).filter(function (img) {
    return img && (img.thumb || img.full);
  });
  // Text-only reviews have no gallery to fill the card, so the quote is
  // allowed to take the whole height instead of a share of it.
  if (!photos.length) card.classList.add("is-text-only");
  if (photos.length) {
    var shown = Math.min(photos.length, 3);
    var strip = el("div", "gr-card__photos");
    strip.setAttribute("data-count", String(shown));

    photos.slice(0, shown).forEach(function (img, i) {
      var btn = el("button", "gr-photo");
      btn.type = "button";
      btn.setAttribute(
        "aria-label",
        "Open photo " + (i + 1) + " of " + photos.length + " from " +
          (review.name || "review")
      );
      btn.appendChild(picture(img, "thumb"));

      var thumbSet = img.thumb || {};
      var bg = thumbSet.jpg || thumbSet.webp || thumbSet.avif;
      if (bg) btn.style.setProperty("--gr-photo-bg", 'url("' + bg + '")');

      // The natural shape of the photo, used by the layout pass to size the
      // tile. Google serves two shapes (3:2 landscape and 2:3 portrait); a tile
      // of the wrong shape used to crop most of the picture away, so the gallery
      // is laid out around the photos instead of forcing one mosaic shape.
      if (img.width && img.height) {
        btn.dataset.ratio = String(img.width / img.height);
      }

      // The last visible tile carries a "+N" overlay when more are hidden.
      var hidden = photos.length - shown;
      if (hidden > 0 && i === shown - 1) {
        btn.appendChild(el("span", "gr-photo__more", "+" + hidden));
      }

      btn.addEventListener("click", function () {
        onPhoto(photos, i, review);
      });
      strip.appendChild(btn);
    });

    inner.appendChild(strip);
  }

  var chips = el("div", "gr-card__chips");
  var addChip = function (iconName, label) {
    if (!label) return;
    var chip = el("span", "gr-chip");
    if (iconName) chip.appendChild(icon(iconName));
    chip.appendChild(document.createTextNode(label));
    chips.appendChild(chip);
  };
  addChip("meal", clean(review.mealType));
  addChip("price", clean(review.pricePerPerson));
  addChip("clock", clean(review.waitTime));
  addChip("noise", clean(review.noiseLevel));
  if (review.food) addChip("check", "Food " + review.food + "/5");
  if (review.service) addChip("check", "Service " + review.service + "/5");
  if (review.atmosphere) addChip("check", "Atmosphere " + review.atmosphere + "/5");
  if (chips.childNodes.length) inner.appendChild(chips);

  var author = el("div", "gr-card__author");
  var avatar = el("span", "gr-avatar", initials(review.name));
  avatar.style.setProperty("--h", hue(review.name));
  avatar.setAttribute("aria-hidden", "true");
  author.appendChild(avatar);

  var who = el("div", "gr-card__who");
  who.appendChild(el("div", "gr-card__name", review.name || "Google user"));
  var metaBits = [];
  if (review.role) metaBits.push(review.role);
  if (review.reviewerReviewCount) {
    metaBits.push(review.reviewerReviewCount + " reviews");
  }
  if (metaBits.length) {
    who.appendChild(el("div", "gr-card__meta", metaBits.join(" \u00B7 ")));
  }
  author.appendChild(who);

  var g = el("span", "gr-card__g");
  g.innerHTML = GOOGLE_G;
  g.setAttribute("title", "Posted on Google");
  author.appendChild(g);

  inner.appendChild(author);
  return card;
}

/* ------------------------------------------------------------ lightbox */

function createLightbox() {
  var box = el("div", "gr-lb");
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Review photo");

  var fig = el("figure", "gr-lb__fig");
  var pic = document.createElement("picture");
  var avifSource = document.createElement("source");
  avifSource.type = "image/avif";
  var webpSource = document.createElement("source");
  webpSource.type = "image/webp";
  var img = document.createElement("img");
  img.alt = "";
  pic.appendChild(avifSource);
  pic.appendChild(webpSource);
  pic.appendChild(img);
  var caption = document.createElement("figcaption");
  fig.appendChild(pic);
  fig.appendChild(caption);

  function setSource(set) {
    if (set.avif) avifSource.srcset = set.avif;
    else avifSource.removeAttribute("srcset");
    if (set.webp) webpSource.srcset = set.webp;
    else webpSource.removeAttribute("srcset");
    img.src = set.jpg || set.webp || set.avif || "";
  }

  var close = el("button", "gr-lb__close");
  close.type = "button";
  close.setAttribute("aria-label", "Close photo");
  close.appendChild(icon("close"));

  var prev = el("button", "gr-lb__nav gr-lb__nav--prev");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous photo");
  prev.appendChild(icon("arrowLeft"));

  var next = el("button", "gr-lb__nav gr-lb__nav--next");
  next.type = "button";
  next.setAttribute("aria-label", "Next photo");
  next.appendChild(icon("arrowRight"));

  box.appendChild(fig);
  box.appendChild(close);
  box.appendChild(prev);
  box.appendChild(next);
  document.body.appendChild(box);

  var photos = [];
  var at = 0;
  var opener = null;

  function paint() {
    var photo = photos[at];
    if (!photo) return;
    var full = photo.full || photo.thumb || {};
    setSource(full);
    img.alt = photo.alt || "";
    caption.textContent = photo.alt || "";
    var many = photos.length > 1;
    prev.hidden = !many;
    next.hidden = !many;
  }

  function step(delta) {
    at = (at + delta + photos.length) % photos.length;
    paint();
  }

  function onKey(event) {
    if (event.key === "Escape") closeBox();
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "Tab") {
      event.preventDefault();
      close.focus();
    }
  }

  function closeBox() {
    box.hidden = true;
    document.removeEventListener("keydown", onKey);
    document.documentElement.style.removeProperty("overflow");
    if (opener && opener.focus) opener.focus();
  }

  close.addEventListener("click", closeBox);
  prev.addEventListener("click", function () {
    step(-1);
  });
  next.addEventListener("click", function () {
    step(1);
  });
  box.addEventListener("click", function (event) {
    if (event.target === box) closeBox();
  });

  return {
    open: function (list, index, trigger) {
      photos = list;
      at = index;
      opener = trigger || null;
      paint();
      box.hidden = false;
      document.documentElement.style.overflow = "hidden";
      document.addEventListener("keydown", onKey);
      close.focus();
    },

    /**
     * Removes the dialog again.
     *
     * The original widget appended the box to `document.body` and never took it out, which is fine
     * for a page that loads once but leaks a dialog per mount in a single-page app. The host calls
     * this on unmount; the document was never touched outside `open`, so hiding and detaching is all
     * that is needed.
     */
    destroy: function () {
      closeBox();
      box.remove();
    }
  };
}

/* -------------------------------------------------------------- slider */

function init(root) {
  if (root.getAttribute("data-gr-ready") === "true") return;
  var dataNode = root.querySelector("[data-gr-reviews-data]");
  if (!dataNode) return;

  var data;
  try {
    data = JSON.parse(dataNode.textContent);
  } catch (err) {
    return;
  }

  var reviews = (data.reviews || []).filter(function (review) {
    return review && (review.comment || (review.images && review.images.length));
  });
  if (!reviews.length) return;

  // Teardown steps are collected here so a single-page host can unmount the slider cleanly; the
  // original widget assumed the page was loaded once and never removed anything.
  var cleanups = [];
  root.__grCleanup = function () {
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch (err) {
        /* a failed teardown step must not block the rest */
      }
    }
    root.removeAttribute("data-gr-ready");
  };

  root.setAttribute("data-gr-ready", "true");

  var place = data.place || {};
  var viewport = root.querySelector("[data-gr-viewport]");
  var track = root.querySelector("[data-gr-track]");
  var prevBtn = root.querySelector("[data-gr-prev]");
  var nextBtn = root.querySelector("[data-gr-next]");
  var playBtn = root.querySelector("[data-gr-play]");
  var bar = root.querySelector("[data-gr-bar]");
  var counter = root.querySelector("[data-gr-counter]");
  var lightbox = createLightbox();

  var cards = [];
  reviews.forEach(function (review, index) {
    var card = buildCard(review, index, function (photos, at) {
      lightbox.open(photos, at, document.activeElement);
    });
    card.setAttribute("aria-label", index + 1 + " of " + reviews.length);
    track.appendChild(card);
    cards.push(card);
  });

  var active = 0;
  var autoplay = null;
  var paused = false;

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function paintState() {
    cards.forEach(function (card, i) {
      card.classList.toggle("is-active", i === active);
    });
    if (bar) bar.style.width = ((active + 1) / cards.length) * 100 + "%";
    if (counter) {
      counter.innerHTML = "";
      counter.appendChild(el("b", null, pad(active + 1)));
      counter.appendChild(document.createTextNode(" / " + pad(cards.length)));
    }
    if (prevBtn) prevBtn.disabled = active === 0;
    if (nextBtn) nextBtn.disabled = active === cards.length - 1;
  }

  function centerOf(card) {
    return card.offsetLeft + card.offsetWidth / 2;
  }

  /* ------------------------------------------------------- 3D fan-out */

  // Cards sit on a diagonal that runs from top-right to bottom-left, so
  // scrolling sweeps them down and to the left. A card to the right of
  // centre rides high and tilts one way; a card to the left drops and tilts
  // the other way. The active card sits flat and closest to the viewer.
  var FAN = {
    reach: 1.05, // card widths from centre at which the fan saturates
    rise: 118, // px a fully-fanned card is offset vertically
    depth: 130, // px it recedes on Z
    tilt: 24, // deg of rotateX at full fan
    ease: 1.5 // >1 keeps the centre card flat for longer
  };

  function fanCard(card, offset) {
    var t = Math.min(Math.abs(offset) / (card.offsetWidth * FAN.reach), 1);
    var eased = Math.pow(t, FAN.ease);
    var side = offset < 0 ? -1 : 1;
    card.style.setProperty("--gr-y", (-side * eased * FAN.rise).toFixed(1) + "px");
    card.style.setProperty("--gr-z", (-eased * FAN.depth).toFixed(1) + "px");
    card.style.setProperty("--gr-rot", (side * eased * FAN.tilt).toFixed(2) + "deg");
    card.style.opacity = String(1 - eased * 0.42);
  }

  function paintFan() {
    var mid = viewport.scrollLeft + viewport.clientWidth / 2;
    cards.forEach(function (card) {
      fanCard(card, centerOf(card) - mid);
    });
  }

  function goTo(index, smooth) {
    var clamped = Math.max(0, Math.min(cards.length - 1, index));
    var card = cards[clamped];
    if (!card) return;
    var left = centerOf(card) - viewport.clientWidth / 2;
    viewport.scrollTo({
      left: left,
      behavior: smooth === false || prefersReducedMotion() ? "auto" : "smooth"
    });
    active = clamped;
    paintState();
    paintFan();
  }

  function nearestIndex() {
    var mid = viewport.scrollLeft + viewport.clientWidth / 2;
    var best = 0;
    var bestDist = Infinity;
    cards.forEach(function (card, i) {
      var dist = Math.abs(centerOf(card) - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  // The fan-out must track the scroll position every frame, so it runs on
  // rAF. The counter is debounced separately so a long smooth scroll only
  // updates it once it settles instead of flickering through every card.
  var fanFrame = 0;
  var settleTimer = 0;

  function onScroll() {
    if (!fanFrame) {
      fanFrame = window.requestAnimationFrame(function () {
        fanFrame = 0;
        paintFan();
      });
    }
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(function () {
      var index = nearestIndex();
      if (index !== active) {
        active = index;
        paintState();
      }
    }, 110);
  }

  viewport.addEventListener("scroll", onScroll, { passive: true });

  /* ------------------------------------------------------- autoplay */

  function stopAutoplay() {
    if (autoplay) {
      window.clearInterval(autoplay);
      autoplay = null;
    }
    if (playBtn) {
      playBtn.setAttribute("aria-label", "Play slideshow");
      playBtn.setAttribute("aria-pressed", "false");
      playBtn.innerHTML = "";
      playBtn.appendChild(icon("play"));
    }
  }

  function startAutoplay() {
    if (autoplay || prefersReducedMotion()) return;
    autoplay = window.setInterval(function () {
      if (paused) return;
      goTo(active + 1 >= cards.length ? 0 : active + 1);
    }, AUTOPLAY_MS);
    if (playBtn) {
      playBtn.setAttribute("aria-label", "Pause slideshow");
      playBtn.setAttribute("aria-pressed", "true");
      playBtn.innerHTML = "";
      playBtn.appendChild(icon("pause"));
    }
  }

  if (playBtn) {
    playBtn.addEventListener("click", function () {
      if (autoplay) stopAutoplay();
      else startAutoplay();
    });
  }

  root.addEventListener("pointerenter", function () {
    paused = true;
  });
  root.addEventListener("pointerleave", function () {
    paused = false;
  });
  // Only the scroll area pauses on focus — pausing on the whole root would
  // make the play button pause itself the moment it is clicked.
  viewport.addEventListener("focusin", function () {
    paused = true;
  });
  viewport.addEventListener("focusout", function () {
    paused = false;
  });

  /* --------------------------------------------------------- controls */

  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      goTo(active - 1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      goTo(active + 1);
    });
  }

  viewport.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goTo(active + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      goTo(active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(cards.length - 1);
    }
  });

  /* ------------------------------------------------------ drag / swipe */

  var drag = null;

  viewport.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      start: viewport.scrollLeft,
      moved: false
    };
    viewport.classList.add("is-dragging");
  });

  viewport.addEventListener("pointermove", function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) {
      drag.moved = true;
      try {
        viewport.setPointerCapture(drag.id);
      } catch (err) {
        /* capture is best-effort */
      }
    }
    if (drag.moved) {
      viewport.scrollLeft = drag.start - dx;
    }
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    var moved = drag.moved;
    drag = null;
    viewport.classList.remove("is-dragging");
    if (moved) {
      goTo(nearestIndex());
    }
  }

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  viewport.addEventListener("click", function (event) {
    if (viewport.classList.contains("is-dragging")) event.preventDefault();
  });

  /* ------------------------------------------------------------ reveal */

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            root.classList.add("is-visible");
            observer.disconnect();
          }
        });
      },
      { threshold: 0.12 }
    );
    observer.observe(root);
  } else {
    root.classList.add("is-visible");
  }

  /* -------------------------------------------------------------- boot */

  var startIndex = Math.min(
    Math.max(parseInt(root.getAttribute("data-start") || "0", 10) || 0, 0),
    cards.length - 1
  );

  /* ------------------------------------------------------- layout fit */

  // The component is designed to sit inside one screen. Flex alone cannot
  // resolve this: the quote and the gallery both want to grow, so the
  // browser ends up overflowing the card. Instead we measure the space the
  // card actually has and hand it out explicitly — fixed rows first, then a
  // share for the quote, and the gallery takes the remainder.
  //
  // The gallery is height-driven, not width-driven.
  //
  // Google serves review photos at two shapes, 3:2 landscape and 2:3 portrait. Filling
  // a fixed mosaic with them cropped most of the picture away: a 2:3 portrait in a
  // 3.3:1 tile showed a fifth of it. Instead every tile is given `aspect-ratio` from
  // its own photo and a height, so its width follows from the picture. Nothing is
  // ever cropped and nothing is letterboxed; the mosaic just gets narrower or wider
  // as the card does.
  function tileRatio(tile) {
    var ratio = parseFloat(tile.dataset.ratio);
    return isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  // Gives every tile its own photo's shape, so the browser derives the width from
  // the height the strip is given.
  // Sizes every tile in pixels from the strip height and each photo's own ratio.
  //
  // Relying on `aspect-ratio` with the flex/grid stretch is not enough in practice: the
  // container hands the item a stretched height, the ratio then only decides the width,
  // and the two disagree just enough to re-crop the picture. Writing both dimensions
  // makes the box exactly the photo's shape, so `object-fit: cover` has nothing to cut.
  function sizeTiles(photos, height) {
    var tiles = photos.querySelectorAll(".gr-photo");
    var count = tiles.length;
    if (!count || !(height > 0)) return;
    var gap = parseFloat(getComputedStyle(photos).rowGap) || 0;

    for (var i = 0; i < count; i++) {
      var ratio = tileRatio(tiles[i]);
      var tileH = count === 3 && i > 0 ? (height - gap) / 2 : height;
      tiles[i].style.height = tileH + "px";
      tiles[i].style.width = ratio * tileH + "px";
    }
  }

  // Total width the mosaic occupies at a given tile height, for a given count.
  function galleryWidthAt(photos, height) {
    var tiles = photos.querySelectorAll(".gr-photo");
    var count = tiles.length;
    var gap = parseFloat(getComputedStyle(photos).columnGap) || 0;
    if (!count) return 0;
    if (count === 1) return tileRatio(tiles[0]) * height;
    if (count === 2) {
      return (tileRatio(tiles[0]) + tileRatio(tiles[1])) * height + gap;
    }
    // Three: the hero spans the strip, the other two stack beside it.
    return tileRatio(tiles[0]) * height + tileRatio(tiles[1]) * (height - gap) / 2 + gap;
  }

  // Tallest tile height that still fits the card's width.
  function galleryHeightForWidth(photos, width) {
    var tiles = photos.querySelectorAll(".gr-photo");
    if (!tiles.length) return 0;
    // galleryWidthAt is linear in height, so solve it directly.
    var perPx = galleryWidthAt(photos, 1000) / 1000;
    return perPx > 0 ? width / perPx : 0;
  }

  // Cards without photos have no gallery to absorb the leftover height, so
  // the quote is allowed to use all of it and is scaled up (within limits)
  // to fill the card instead of leaving a large empty area.
  function fitCard(card) {
    var inner = card.querySelector(".gr-card__inner");
    var body = card.querySelector(".gr-card__body");
    var quote = card.querySelector(".gr-card__quote");
    var more = card.querySelector(".gr-card__more");
    var photos = card.querySelector(".gr-card__photos");
    var chips = card.querySelector(".gr-card__chips");
    var author = card.querySelector(".gr-card__author");
    var top = card.querySelector(".gr-card__top");

    var expanded = quote && quote.dataset.expanded === "1";

    // Reset to natural sizes before measuring.
    card.classList.remove("is-compact");
    card.classList.remove("is-short");
    if (quote) {
      quote.style.removeProperty("font-size");
      quote.style.removeProperty("--gr-clamp");
      if (!expanded) quote.classList.remove("is-clamped");
    }
    if (photos) {
      photos.style.removeProperty("height");
      var stale = photos.querySelectorAll(".gr-photo");
      for (var t = 0; t < stale.length; t++) {
        stale[t].style.removeProperty("height");
        stale[t].style.removeProperty("width");
      }
    }
    if (more) more.hidden = false;

    var cs = getComputedStyle(inner);
    var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var gap = parseFloat(cs.rowGap) || 0;
    var available = inner.clientHeight - padY;

    var rows = [top, body, photos, chips, author].filter(function (node) {
      return node && node.offsetParent !== null && !node.hidden;
    });
    var gaps = Math.max(0, rows.length - 1) * gap;

    var fixed = 0;
    [top, author, chips].forEach(function (node) {
      if (node && node.offsetParent !== null) {
        fixed += node.getBoundingClientRect().height;
      }
    });

    var moreH = more && !more.hidden ? more.getBoundingClientRect().height : 0;
    // "Read more" sits inside the body block, so it takes vertical space
    // there along with the body's own gap — reserve both.
    var moreIsSibling = more && more.parentNode === inner;
    var moreCost = moreH;
    if (moreH && !moreIsSibling && body) {
      moreCost += parseFloat(getComputedStyle(body).rowGap) || 0;
    }
    var budget = available - fixed - gaps - moreCost;
    // Width the mosaic may use: the card's content box.
    var availableWidth = inner.clientWidth;


    // Not enough room for everything: drop the chips, then tighten spacing.
    if (budget < 150) {
      card.classList.add("is-compact");
      if (chips) fixed -= chips.getBoundingClientRect().height;
      budget = available - fixed - gaps - moreCost;
    }

    var quoteNeeded = quote ? quote.scrollHeight : 0;
    var galleryIdeal = photos ? galleryHeightForWidth(photos, availableWidth) : 0;
    var lineH = quote ? parseFloat(getComputedStyle(quote).lineHeight) || 24 : 0;
    // One readable line plus the toggle is the least a quote should get; below
    // that the clamp would hide the review entirely.
    var quoteFloor = quote ? lineH * 1.5 : 0;

    // The gallery is measured first and the text takes what is left. Handing
    // the text a fixed share instead squeezed tall cards into thin photo strips
    // (a 3.3:1 tile showing a fifth of the picture), which is what the gallery
    // used to do whenever the card was shorter than a full screen.
    // A gallery floor keeps a photo review from turning into a 20px strip on a
    // cramped phone; below that the quotes are clamped harder instead, and the
    // card scrolls if even that does not fit.
    var GALLERY_FLOOR = 96;
    var galleryFloor = photos ? Math.min(GALLERY_FLOOR, budget * 0.5) : 0;

    var quoteShare;
    if (!photos) {
      quoteShare = quote ? Math.min(quoteNeeded, budget) : 0;
    } else {
      quoteShare = quote ? Math.min(quoteNeeded, Math.max(0, budget - galleryIdeal)) : 0;
      if (quoteShare < quoteFloor) {
        // Not enough room for both: keep the text readable and give the gallery
        // the height it needs, or the floor when even that is too much.
        quoteShare = Math.min(quoteNeeded, Math.max(0, budget - Math.max(galleryFloor, galleryIdeal * 0.72)));
      }
    }
    var galleryShare = Math.max(photos ? galleryFloor : 0, budget - quoteShare);

    if (quote && !expanded && quoteNeeded > quoteShare + 2) {
      var lines = Math.max(2, Math.floor(quoteShare / lineH));
      quote.style.setProperty("--gr-clamp", String(lines));
      quote.classList.add("is-clamped");
      if (more) more.hidden = false;
    } else if (more && !expanded) {
      more.hidden = true;
    }

    if (photos) {
      photos.style.height = galleryShare + "px";
      sizeTiles(photos, galleryShare);
    }

    // Text-only card: grow the type until the quote fills the card, so a
    // short review does not leave most of the card blank. The quote clips
    // its own overflow, so its height must be measured directly — the
    // parent's scrollHeight never grows when the text spills.
    if (quote && !photos && !expanded && !quote.classList.contains("is-clamped")) {
      var baseSize = parseFloat(getComputedStyle(quote).fontSize) || 16;
      // A short review has room to spare, so it may grow well past the
      // normal reading size and read as a pull-quote.
      var maxSize = Math.min(baseSize * 3, 42);
      // The budget reserved room for "Read more"; if it ended up hidden the
      // quote can use that space too.
      var room = budget + (more && more.hidden ? moreCost : 0);
      var fits = function (size) {
        quote.style.fontSize = size + "px";
        return quote.scrollHeight <= room;
      };
      if (maxSize > baseSize && fits(baseSize)) {
        var lo = baseSize;
        var hi = maxSize;
        for (var step = 0; step < 7; step++) {
          var mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        quote.style.fontSize = lo + "px";
      } else {
        quote.style.fontSize = baseSize + "px";
      }

      // Even at the size cap a one- or two-line review leaves the card
      // mostly empty, so those are set as a centred pull-quote instead.
      // This adds the oversized mark, so it has to happen before the final
      // fit check.
      var lineH = parseFloat(getComputedStyle(quote).lineHeight) || 24;
      card.classList.toggle("is-short", quote.scrollHeight <= lineH * 2.2);

      // Flex can still squeeze the quote below its content height, which
      // would clip the last line. Back the type off until nothing is cut.
      var size = parseFloat(quote.style.fontSize) || baseSize;
      for (var guard = 0; guard < 24; guard++) {
        var clipped = quote.scrollHeight - quote.clientHeight > 1;
        var spills = inner.scrollHeight - inner.clientHeight > 1;
        if (!clipped && !spills) break;
        size = Math.max(baseSize, size - Math.max(0.5, size * 0.02));
        quote.style.fontSize = size + "px";
      }
    }

    // Flex rounding, margins and the clamp all shift the result slightly.
    // Measure what actually happened and correct the gallery height until
    // the card fits, so nothing is ever clipped. An expanded quote is a
    // deliberate overflow: the card scrolls instead of crushing the gallery.
    if (photos && !expanded) {
      for (var pass = 0; pass < 6; pass++) {
        var over = inner.scrollHeight - inner.clientHeight;
        if (over <= 0) break;
        var current = parseFloat(photos.style.height) || photos.offsetHeight;
        var next = Math.max(GALLERY_FLOOR * 0.6, current - over - 1);
        if (next >= current) break;
        photos.style.height = next + "px";
        // The tiles are sized from this height, so they have to follow the
        // correction — otherwise the boxes keep the old size and the photo is
        // stretched back out.
        sizeTiles(photos, next);
      }
    }

    // A clamped quote has no gallery to give up height, so drop a line at a
    // time until the card fits.
    if (quote && !photos && !expanded && quote.classList.contains("is-clamped")) {
      for (var shrink = 0; shrink < 8; shrink++) {
        if (inner.scrollHeight - inner.clientHeight <= 1) break;
        var lines = parseInt(quote.style.getPropertyValue("--gr-clamp"), 10) || 0;
        if (lines <= 2) break;
        quote.style.setProperty("--gr-clamp", String(lines - 1));
      }
    }
  }

  function fitCards() {
    cards.forEach(fitCard);
  }

  requestFit = fitCards;

  // Wait a frame so fonts/layout settle before measuring card offsets.
  window.requestAnimationFrame(function () {
    fitCards();
    goTo(startIndex, false);
    paintFan();
    if (root.getAttribute("data-autoplay") !== "false") startAutoplay();
  });

  // Web fonts change the text metrics, so the fit pass has to run again once
  // they are in — otherwise the quote is sized against the fallback font.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      fitCards();
      paintFan();
    });
  }

  var resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      fitCards();
      goTo(active, false);
      paintFan();
    }, 120);
  }
  window.addEventListener("resize", onResize);

  cleanups.push(function () {
    window.removeEventListener("resize", onResize);
    window.clearTimeout(resizeTimer);
    window.clearTimeout(settleTimer);
    if (fanFrame) window.cancelAnimationFrame(fanFrame);
    stopAutoplay();
    lightbox.destroy();
    root.removeAttribute("aria-busy");
  });
}

function boot() {
  var roots = document.querySelectorAll("[data-gr-reviews]");
  for (var i = 0; i < roots.length; i++) init(roots[i]);
}

/**
 * Initialises one slider inside `root`.
 *
 * Exported for the React host, which renders the markup after this module has loaded, so the
 * one-shot auto-boot below cannot see it yet. Safe to call more than once: `init` returns early when
 * the element is already marked `data-gr-ready`.
 *
 * @param {Element} root Element carrying `data-gr-reviews` and the JSON data script.
 */
export { init as initReviewsSlider };

/**
 * Tears a slider down again.
 *
 * Removes the listeners, timers and the lightbox element the widget adds to `document.body`, and
 * clears `data-gr-ready` so the same node could be initialised again. Call it from the host's effect
 * cleanup; a slider that was never initialised is ignored.
 *
 * @param {Element} root Element previously passed to `initReviewsSlider`.
 */
export function destroyReviewsSlider(root) {
  if (root && typeof root.__grCleanup === "function") root.__grCleanup();
}

// Server-rendered pages (the collector's own preview, or a CMS paste) are still booted automatically.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
