/**
 * "Signature Dishes" showcase for the home page.
 *
 * The photos are square, branded, and have the dish name printed into the artwork, so they are
 * shown uncropped in a scroll-snap carousel. A grid was tried first but 24 square photos in three
 * columns run to eight rows and push the rest of the page far down; a carousel keeps the section
 * one screen tall and still makes every photo reachable.
 *
 * The carousel is native scrolling (`overflow-x: auto` + `scroll-snap-type`), which means touch and
 * trackpad gestures work without any JavaScript and nothing is lost if the script fails. The
 * buttons and dots are progressive enhancement on top of that.
 *
 * The whole catalogue is rendered on the server-rendered markup and never filtered, so the page
 * works with JavaScript disabled and search engines see every dish. Images are `loading="lazy"`,
 * which leaves the first row to load eagerly enough for a good LCP while the rest wait.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dishes from "./dishes.js";

/** How many photos advance per click; matches the widest visible layout minus one. */
const SCROLL_FRACTION = 0.8;

/**
 * A single dish photo with WebP/JPEG sources and a low-quality placeholder.
 *
 * The `picture` element lets the browser pick WebP when it can; the `img` carries the JPEG. The
 * placeholder paints immediately via the wrapper's background so a slow photo shows a blurred hint
 * rather than an empty box, and is removed once the real image decodes.
 *
 * @param {{ dish: import('./dishes.js').Dish, priority: boolean }} props `priority` opts the first
 *   slide out of lazy loading so the section's largest image is not deferred.
 */
function DishImage({ dish, priority }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <span className="dish-photo" style={{ backgroundImage: `url("${dish.placeholder}")` }}>
      <picture>
        <source
          type="image/webp"
          srcSet={`${dish.webp[400]} 400w, ${dish.webp[800]} 800w`}
          sizes="(max-width: 680px) 82vw, (max-width: 980px) 45vw, 340px"
        />
        <img
          src={dish.jpg[800]}
          srcSet={`${dish.jpg[400]} 400w, ${dish.jpg[800]} 800w`}
          sizes="(max-width: 680px) 82vw, (max-width: 980px) 45vw, 340px"
          width={dish.width}
          height={dish.height}
          alt={dish.caption}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={loaded ? "is-loaded" : undefined}
        />
      </picture>
      {/* The dish name is printed into the photo itself, so the visible caption stays empty:
          repeating it underneath would say the same thing twice. Screen readers use the alt. */}
    </span>
  );
}

/**
 * Signature Dishes carousel.
 *
 * Tracks the scroll position so the arrow buttons disable at the ends and the dots stay in sync.
 * Both are read straight from the DOM node because the browser is the source of truth for scroll
 * geometry; keeping a duplicate index in state would drift during momentum scrolling.
 */
export default function DishShowcase() {
  const trackRef = useRef(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  /** Reads the current scroll position and updates the button/dot state. */
  const syncScrollState = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    // A one-pixel tolerance absorbs fractional layout widths.
    setAtStart(track.scrollLeft <= 1);
    setAtEnd(track.scrollLeft + track.clientWidth >= track.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;

    syncScrollState();
    track.addEventListener("scroll", syncScrollState, { passive: true });

    // The end position depends on the rendered width, so it has to be recomputed on resize.
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(track);

    return () => {
      track.removeEventListener("scroll", syncScrollState);
      observer.disconnect();
    };
  }, [syncScrollState]);

  /**
   * Scrolls the track by roughly a screenful.
   *
   * @param {1|-1} direction Positive to advance, negative to go back.
   */
  const scrollByPage = useCallback((direction) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({
      left: direction * track.clientWidth * SCROLL_FRACTION,
      behavior: "smooth",
    });
  }, []);

  /**
   * Scrolls a particular slide into view, for the dots.
   *
   * @param {number} index Slide to centre.
   */
  const scrollToSlide = useCallback((index) => {
    const track = trackRef.current;
    const slide = track?.children[index];
    if (!track || !slide) return;
    // offsetLeft is relative to the section, so subtract the track's own offset. Clamp to the
    // scrollable range: the trailing slides cannot be scrolled all the way to the left edge, and
    // without the clamp the last dot would land short of the real end.
    const target = slide.offsetLeft - track.offsetLeft;
    const maxScroll = track.scrollWidth - track.clientWidth;
    track.scrollTo({ left: Math.min(target, maxScroll), behavior: "smooth" });
  }, []);

  if (!dishes.length) {
    return (
      <section className="panel dishes-showcase">
        <div className="dishes-head">
          <h2>Signature Dishes</h2>
          <p>Unsere beliebtesten Gerichte, frisch serviert und mit viel Geschmack.</p>
        </div>
        <p>Derzeit sind keine Dish-Bilder hinterlegt.</p>
      </section>
    );
  }

  return (
    <section className="panel dishes-showcase">
      <div className="dishes-head">
        <div>
          <h2>Signature Dishes</h2>
          <p>Unsere beliebtesten Gerichte, frisch serviert und mit viel Geschmack.</p>
        </div>
        <div className="dishes-nav">
          <button
            type="button"
            className="dishes-arrow"
            aria-label="Vorherige Gerichte"
            onClick={() => scrollByPage(-1)}
            disabled={atStart}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            className="dishes-arrow"
            aria-label="Weitere Gerichte"
            onClick={() => scrollByPage(1)}
            disabled={atEnd}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* role="region" + tabIndex make the scroller keyboard-reachable; the browser turns the
          arrow keys into scrolling once it has focus. */}
      <ul
        className="dish-track"
        ref={trackRef}
        tabIndex={0}
        role="region"
        aria-roledescription="Karussell"
        aria-label={`${dishes.length} Gerichte`}
      >
        {dishes.map((dish, index) => (
          <li className="dish-slide" key={dish.slug}>
            <DishImage dish={dish} priority={index < 3} />
          </li>
        ))}
      </ul>

      <div className="dishes-dots" role="tablist" aria-label="Gericht auswählen">
        {dishes.map((dish, index) => (
          <button
            key={dish.slug}
            type="button"
            role="tab"
            aria-label={dish.caption}
            aria-selected={false}
            onClick={() => scrollToSlide(index)}
          />
        ))}
      </div>
    </section>
  );
}
