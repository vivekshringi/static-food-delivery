/**
 * Home page review slider: mounts the review-collector widget as a React component.
 *
 * The widget is vanilla DOM code (`widget.js`) that finds its data in a
 * `<script type="application/json" data-gr-reviews-data>` child and then owns that subtree. Porting it
 * to React state would mean rewriting the scroll-driven 3D layout, the fit pass and the lightbox, so
 * the developed component is used as-is: this file renders the exact markup it expects, hands the
 * JSON payload over as embedded text, and calls its `init` once.
 *
 * Consequences worth knowing:
 *   - React must not re-render the widget's subtree, so the markup below is static JSX and the payload
 *     is a plain `<script>` string. Only the wrapper's `className` is dynamic.
 *   - The payload is serialised once at module load, not per render.
 *   - `init` is idempotent (`data-gr-ready`), which keeps React 18 StrictMode's double effect harmless.
 */

import { useEffect, useRef } from "react";
import reviewsData from "./reviewsData.js";
import { destroyReviewsSlider, initReviewsSlider } from "./widget.js";
import "./widget.css";
import "./reviewsSlider.css";

// The widget parses the JSON itself, so a string is enough here and there is no per-render cost.
const PAYLOAD_JSON = JSON.stringify(reviewsData);

const GOOGLE_G = (
  <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path
      fill="#4285F4"
      d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 2-1.5 5-4.4 7l-.1.3 6.4 4.9.4.1c4-3.7 6.7-9.2 6.7-15.6"
    />
    <path
      fill="#34A853"
      d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.3c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-.3.1-6.6 5.1-.1.3C8.1 41 15.4 46 24 46"
    />
    <path
      fill="#FBBC05"
      d="M11.5 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.7-4.5v-.3L4.7 14l-.2.1A22 22 0 002 24c0 3.5.9 6.9 2.5 9.9z"
    />
    <path
      fill="#EA4335"
      d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.2 29.9 2 24 2 15.4 2 8.1 7 4.5 14.1l7 5.4c1.8-5.3 6.7-9.1 12.5-9.1"
    />
  </svg>
);

const STAR_PATH = "M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z";

/**
 * Builds the five-star rating row for the header summary.
 *
 * Mirrors the widget's own `stars()` helper: a single `role="img"` wrapper with an accessible label,
 * and `is-on` on the filled stars so the styling comes from the copied stylesheet.
 *
 * @param {number} rating Average rating; rounded to decide how many stars are filled.
 */
function StarRow({ rating }) {
  return (
    <span className="gr-stars gr-stars--lg" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((index) => (
        <svg
          key={index}
          viewBox="0 0 24 24"
          className={`gr-star${index <= Math.round(rating) ? " is-on" : ""}`}
          aria-hidden="true"
        >
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  );
}

/**
 * Renders the review slider.
 *
 * The markup is the one `build-widget.js` generates: header (eyebrow, headline, score, Google link),
 * the slider shell the script fills with cards, and the embedded payload. The script then takes over
 * that subtree, so nothing below `rootRef` may depend on React state.
 *
 * @param {object} [props]
 * @param {string} [props.className] Extra class on the section, e.g. spacing for its page slot.
 */
export default function ReviewsSlider({ className = "" }) {
  const rootRef = useRef(null);

  // Mounts the slider once. init() is a no-op when the element is already ready, so StrictMode's
  // second invocation in development does not build the cards twice.
  //
  // The cleanup matters in this app: React Router unmounts HomePage when the visitor opens the menu or
  // the chat, and the widget registers window/scroll listeners, timers and a lightbox element on
  // `document.body`. Without the teardown each visit would add another copy of them.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    initReviewsSlider(root);
    return () => destroyReviewsSlider(root);
  }, []);

  const { place, reviews } = reviewsData;
  const rating = Number(place.rating) || 5;
  // Prefer the advertised Google total over the number of reviews captured in the payload.
  const reviewCount = Number(place.reviewCount) || reviews.length;

  return (
    <section
      ref={rootRef}
      className={`gr-reviews${className ? ` ${className}` : ""}`}
      data-gr-reviews
      data-autoplay="true"
      data-start="0"
    >
      <div className="gr-reviews__glow" aria-hidden="true" />
      <div className="gr-reviews__inner">
        <header className="gr-reviews__head">
          <span className="gr-reviews__eyebrow">
            <span className="gr-gbadge">{GOOGLE_G}</span>
            Google Reviews
          </span>
          <h2 className="gr-reviews__title">
            Loved by <em>real guests.</em>
          </h2>
          <div className="gr-reviews__summary">
            <span className="gr-reviews__score">{rating.toFixed(1)}</span>
            <span className="gr-reviews__score-meta">
              <StarRow rating={rating} />
              <span className="gr-reviews__count">
                Based on {reviewCount} Google reviews{place.name ? ` for ${place.name}` : ""}
              </span>
            </span>
            {place.url ? (
              <a
                className="gr-reviews__link"
                href={place.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read on Google
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </a>
            ) : null}
          </div>
        </header>

        <div className="gr-slider">
          <div
            className="gr-slider__viewport"
            data-gr-viewport
            tabIndex={0}
            role="region"
            aria-roledescription="carousel"
            aria-label="Google reviews"
          >
            <div className="gr-slider__track" data-gr-track />
          </div>

          <div className="gr-slider__controls">
            <button className="gr-btn" type="button" data-gr-prev aria-label="Previous review">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M15 5l-7 7 7 7" />
              </svg>
            </button>
            <div className="gr-slider__progress" aria-hidden="true">
              <span data-gr-bar />
            </div>
            <span className="gr-slider__counter" data-gr-counter aria-live="polite" />
            <button className="gr-btn" type="button" data-gr-next aria-label="Next review">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              className="gr-btn gr-btn--ghost"
              type="button"
              data-gr-play
              aria-label="Play slideshow"
              aria-pressed="false"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M8 5l11 7-11 7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Plain text on purpose: React must not manage this node, and the widget reads it verbatim.
          The payload is our own literal, so no markup can break out of the script element. */}
      <script type="application/json" data-gr-reviews-data>
        {PAYLOAD_JSON}
      </script>
    </section>
  );
}
