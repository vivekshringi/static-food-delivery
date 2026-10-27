/**
 * Root of the SPA: fetches `/api/content` once and renders every public page plus the admin screens.
 *
 * Layout is `header → routes → footer → cookie banner`, with the routes rendered only after content
 * loads. Content is fetched here rather than per page because every page needs it (brand, footer,
 * offers, impressum), and pages that need live data (`MenuPage`, `OrdersPage`, `ChatPage`) fetch their
 * own.
 *
 * The admin edit form is the only writer: it PUTs the full content document back, so normalization and
 * validation stay on the server.
 *
 * `ADMIN_TOKEN_KEY` must match the one in `OrdersPage.jsx`.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import ChatPage from "./ChatPage.jsx";
import DishShowcase from "./DishShowcase.jsx";
import OrdersPage from "./OrdersPage.jsx";
import ReviewsSlider from "./reviews/ReviewsSlider.jsx";
import "./ordering.css";

const ADMIN_TOKEN_KEY = "adminTokenSessionV1";
// Matches scheme-relative and absolute URLs ("//cdn…", "https://…", "data:…").
const ABSOLUTE_URL_PATTERN = /^(?:[a-z]+:)?\/\//i;

/**
 * Turns the multi-line address from content.json into one search string for Google Maps.
 *
 * Line breaks are meaningless in a map query, so "Wendenstraße 197\n20537 Hamburg" becomes
 * "Wendenstraße 197, 20537 Hamburg".
 *
 * @param {string} address Address as stored in the admin form.
 * @returns {string} Comma-separated query, or `""` when the address is empty.
 */
function buildGoogleMapsLocationQuery(address) {
  return String(address || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Builds the Google Maps embed URL for the home page map.
 *
 * @param {string} address Address as stored in the admin form.
 * @returns {string} Embed URL, or `""` when there is no address (the map block is then skipped).
 */
function buildGoogleMapsEmbedUrl(address) {
  const query = buildGoogleMapsLocationQuery(address);
  return query ? `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : "";
}

/**
 * Resolves an image URL from content.json for the built app.
 *
 * Content stores site-relative paths like `/images/entrance.png`, but the bundle may be served
 * under a base path, so those are rebased onto `BASE_URL`. Absolute, `data:` and `blob:` URLs are
 * passed through untouched, and a blank value falls back to `fallbackUrl` — which is why a mistyped
 * admin field shows a working image instead of a broken one.
 *
 * @param {string} url Preferred image URL from content.
 * @param {string} fallbackUrl Image to use when `url` is blank.
 * @returns {string} URL ready for an `<img src>`; `""` when both inputs are empty.
 */
function resolveImageUrl(url, fallbackUrl) {
  const candidate = String(url || "").trim() || String(fallbackUrl || "").trim();

  if (!candidate) {
    return "";
  }

  if (ABSOLUTE_URL_PATTERN.test(candidate) || candidate.startsWith("data:") || candidate.startsWith("blob:")) {
    return candidate;
  }

  const normalized = candidate.startsWith("/") ? candidate.slice(1) : candidate;
  return `${import.meta.env.BASE_URL}${normalized}`;
}

/**
 * `<img>` that swaps to a fallback once if the configured source fails to load.
 *
 * The content URLs are entered by hand in the admin form, so a typo would otherwise leave a broken
 * image on the home page. The swap happens once (`resolvedSrc !== resolvedFallback` guard), which
 * avoids an infinite error loop when the fallback is missing too. The source is re-resolved whenever
 * `src` or `fallbackSrc` change, so saving new content updates the image without a reload.
 *
 * @param {object} props
 * @param {string} props.src Preferred image URL.
 * @param {string} props.fallbackSrc Used when `src` is blank or fails to load.
 * @param {...object} props Rest spread onto the `<img>` (alt, className, …).
 */
function SafeImage({ src, fallbackSrc, ...props }) {
  const resolvedFallback = useMemo(() => resolveImageUrl(fallbackSrc, fallbackSrc), [fallbackSrc]);
  const [resolvedSrc, setResolvedSrc] = useState(() => resolveImageUrl(src, fallbackSrc));

  useEffect(() => {
    setResolvedSrc(resolveImageUrl(src, fallbackSrc));
  }, [src, fallbackSrc]);

  // One-time fallback swap: without the equality guard a missing fallback would loop forever.
  function handleError() {
    if (resolvedFallback && resolvedSrc !== resolvedFallback) {
      setResolvedSrc(resolvedFallback);
    }
  }

  return <img {...props} src={resolvedSrc} onError={handleError} />;
}

// Empty starting point for the admin edit form, mirroring the fields content.json stores. Multi-value
// fields are kept as newline-separated text (`offersText`) and split on save, so the admin edits one
// item per line instead of learning a JSON syntax.
//
// The dish photos are not part of this form: they are a build artefact generated from
// `assets/dishes-source` by `scripts/optimize-dishes.mjs`, not editable content.
const initialFormState = {
  restaurantName: "",
  logoUrl: "",
  entranceImageUrl: "",
  cuisine: "",
  description: "",
  address: "",
  phone: "",
  mobile: "",
  taxId: "",
  timing: "",
  offersText: "",
  instagram: "",
  facebook: "",
  wolt: "",
  lieferando: "",
  fritzKola: "",
  googlePlaceId: "",
  googlePlaceName: "",
  impressumOwnerName: "",
  impressumEmail: "",
  impressumManagingDirector: "",
  impressumRegisterCourt: "",
  impressumRegistryNumber: "",
  impressumTaxNumber: "",
  impressumDisputeResolution: ""
};

/**
 * App shell: loads the shared content document, renders the header/footer, and routes every page.
 *
 * Content is fetched once here instead of per page; `loadContent` is also handed to `AdminEditPage`
 * as `onUpdated`, so saving or uploading a menu refreshes the whole shell without a reload.
 */
function App() {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Fetches the current content document from `/api/content`.
   *
   * Any failure is surfaced in the error banner and leaves the routes unmounted, because every page
   * reads `content` and half-rendering without it would show blank headings. Also used as the
   * post-save refresh callback for the admin form.
   */
  async function loadContent() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/content");
      if (!response.ok) {
        throw new Error("Inhalte konnten nicht geladen werden");
      }
      const payload = await response.json();
      setContent(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadContent();
  }, []);

  return (
    <div className="site-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <SafeImage
            src={content?.logoUrl || "/images/spice-anker-logo.png"}
            fallbackSrc="/images/spice-anker-logo.png"
            alt="Spice Anker Logo"
            className="brand-logo"
          />
          <span>{content?.restaurantName || "Spice Anker"}</span>
        </Link>
        <div className="header-actions">
          <nav className="menu-links">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/menu">Menu</NavLink>
            <NavLink to="/ordernow">Order Now</NavLink>
          </nav>
        </div>
      </header>

      <main>
        {loading ? <p className="state-text">Inhalte werden geladen ...</p> : null}
        {error ? <p className="state-error">{error}</p> : null}

        {!loading && !error && content ? (
          <Routes>
            <Route path="/" element={<HomePage content={content} />} />
            <Route path="/menu" element={<MenuPage content={content} />} />
            <Route path="/ordernow" element={<ChatPage />} />
            <Route path="/bestellen" element={<Navigate to="/ordernow" replace />} />
            <Route path="/chat" element={<Navigate to="/ordernow" replace />} />
            {/* OrdersPage reads the admin token itself: the token is stored after the App has
                rendered, so a prop captured here would still be empty and bounce to the login. */}
            <Route path="/currentOrders" element={<OrdersPage />} />
            <Route path="/orders" element={<Navigate to="/currentOrders" replace />} />
            <Route path="/impressum" element={<ImpressumPage content={content} />} />
            <Route path="/admin" element={<AdminAuthPage />} />
            <Route path="/admin/edit" element={<AdminEditPage content={content} onUpdated={loadContent} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : null}
      </main>

      {!loading && !error && content ? <SiteFooter content={content} /> : null}
      <CookieConsent />
    </div>
  );
}

/**
 * Landing page: hero, signature dishes, address with an embedded map, opening hours, offers, delivery
 * partners and the drinks partner.
 *
 * Every block is conditional on its content field, so removing an entry in the admin form removes the
 * block instead of leaving an empty heading.
 *
 * @param {{ content: object }} props Normalised content from `/api/content`.
 */
function HomePage({ content }) {
  const delivery = content.delivery || {};
  const drinks = content.drinks || {};
  const entranceImageUrl = content.entranceImageUrl || "/images/entrance.png";
  const googleMapsLocationQuery = buildGoogleMapsLocationQuery(content.address);
  const googleMapsEmbedUrl = buildGoogleMapsEmbedUrl(content.address);

  return (
    <section className="page page-home">
      <div className="hero">
        <div className="hero-layout">
          <div className="hero-copy">
            <SafeImage
              src={content.logoUrl || "/images/spice-anker-logo.png"}
              fallbackSrc="/images/spice-anker-logo.png"
              alt="Logo"
              className="hero-logo"
            />
            <p className="eyebrow">Contemporary Indian Kitchen</p>
            <h1>{content.restaurantName}</h1>
            <p>{content.description}</p>
            <div className="hero-actions">
              <Link className="hero-btn" to="/menu">
                Speisekarte ansehen
              </Link>
            </div>
          </div>
          <figure className="hero-visual">
            <SafeImage
              src={entranceImageUrl}
              fallbackSrc="/images/entrance.png"
              alt={`${content.restaurantName} Eingang`}
              className="hero-image"
            />
            <figcaption>Eingang von {content.restaurantName}</figcaption>
          </figure>
        </div>
      </div>

      <ReviewsSlider className="reviews-section" />

      <DishShowcase />

      <div className="grid-details">
        <article className="panel">
          <h2>Adresse</h2>
          <p className="address-text">{content.address}</p>
          {googleMapsEmbedUrl ? (
            <div className="map-card">
              <iframe
                title="Google Maps Standort"
                src={googleMapsEmbedUrl}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
              />
              <a
                className="map-link"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleMapsLocationQuery)}`}
                target="_blank"
                rel="noreferrer"
              >
                In Google Maps öffnen
              </a>
            </div>
          ) : null}
          {(content.phone || content.mobile) && (
            <div className="phone-links">
              {content.phone ? (
                <a href={`tel:${content.phone.replace(/\s/g, "")}`}>Telefon: {content.phone}</a>
              ) : null}
              {content.mobile ? (
                <a href={`tel:${content.mobile.replace(/\s/g, "")}`}>Mobil: {content.mobile}</a>
              ) : null}
            </div>
          )}
        </article>
        <article className="panel">
          <h2>Offnungszeiten</h2>
          <p className="address-text">{content.timing}</p>
        </article>
      </div>

      <section className="offers">
        <h2>Upcoming Offers</h2>
        <div className="offer-list">
          {content.offers?.length ? (
            content.offers.map((offer) => (
              <article className="offer" key={offer}>
                <p>{offer}</p>
              </article>
            ))
          ) : (
            <p>Derzeit keine Teaser-Angebote verfugbar.</p>
          )}
        </div>
      </section>

      <section className="delivery-availability panel">
        <h2>Jetzt auch bei Lieferdiensten</h2>
        <p>Bestelle unsere Gerichte bequem uber Wolt und Lieferando.</p>
        <div className="delivery-links">
          {delivery.wolt ? (
            <a href={delivery.wolt} target="_blank" rel="noreferrer" className="delivery-icon-link" title="Wolt">
              <SafeImage src="/icons/wolt.png" fallbackSrc="/icons/wolt.png" alt="Wolt" className="delivery-icon" />
            </a>
          ) : null}
          {delivery.lieferando ? (
            <a
              href={delivery.lieferando}
              target="_blank"
              rel="noreferrer"
              className="delivery-icon-link"
              title="Lieferando"
            >
              <SafeImage
                src="/icons/lieferando.png"
                fallbackSrc="/icons/lieferando.png"
                alt="Lieferando"
                className="delivery-icon"
              />
            </a>
          ) : null}
        </div>
      </section>

      <section className="panel drinks-partner">
        <h2>Unser Getraenkepartner</h2>
        <p>Fritz-Kola ist unser Getraenkepartner und in Hamburg besonders beliebt.</p>
        {drinks.fritzKola ? (
          <a
            href={drinks.fritzKola}
            target="_blank"
            rel="noreferrer"
            className="delivery-logo-link"
            title="Fritz-Kola"
          >
            <SafeImage
              src="/icons/fritz-kola.png"
              fallbackSrc="/icons/fritz-kola.png"
              alt="Fritz-Kola"
              className="drinks-logo"
            />
          </a>
        ) : null}
      </section>
    </section>
  );
}

/**
 * Site footer: social links (shown only when configured) and the impressum link the German
 * Impressumspflicht requires on every page.
 *
 * @param {{ content: object }} props
 */
function SiteFooter({ content }) {
  const social = content.social || {};

  return (
    <footer className="site-footer">
      <div className="footer-column">
        <p>Folge uns fur neue Offers und Events:</p>
        <div className="social-links">
          {social.instagram ? (
            <a href={social.instagram} target="_blank" rel="noreferrer" className="social-icon-link" title="Instagram">
              <SafeImage
                src="/icons/instagram.png"
                fallbackSrc="/icons/instagram.png"
                alt="Instagram"
                className="social-icon"
              />
            </a>
          ) : null}
          {social.facebook ? (
            <a href={social.facebook} target="_blank" rel="noreferrer" className="social-icon-link" title="Facebook">
              <SafeImage
                src="/icons/facebook.png"
                fallbackSrc="/icons/facebook.png"
                alt="Facebook"
                className="social-icon"
              />
            </a>
          ) : null}
        </div>
        <nav className="footer-legal">
          <Link to="/impressum">Impressum</Link>
        </nav>
      </div>
    </footer>
  );
}

/**
 * Printed menu page with a lunch/dinner tab switch.
 *
 * Fetches `/api/menu` itself (the shell does not) because the menu is large and only needed here. This
 * is the readable menu without ordering codes; the codes live in the chat's menu card and
 * `/api/order-menu`. A PDF link is always offered for printing.
 *
 * @param {{ content: object }} props `content.menuUrl` overrides the default `/menu.pdf`.
 */
function MenuPage({ content }) {
  const pdfUrl = content.menuUrl || "/menu.pdf";
  const [menus, setMenus] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("lunch");

  useEffect(() => {
    fetch("/api/menu")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("menu"))))
      .then(setMenus)
      .catch(() => setError("Die Speisekarte konnte nicht geladen werden."));
  }, []);

  const menu = menus?.[tab];
  const euro = (value) => `${value.toFixed(2).replace(".", ",")} €`;

  return (
    <section className="page page-menu">
      <h1>Unsere Speisekarte</h1>
      <div className="menu-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "lunch"} className={tab === "lunch" ? "active" : ""} onClick={() => setTab("lunch")}>
          Mittagskarte (bis 16 Uhr)
        </button>
        <button type="button" role="tab" aria-selected={tab === "dinner"} className={tab === "dinner" ? "active" : ""} onClick={() => setTab("dinner")}>
          Abendkarte (ab 16 Uhr)
        </button>
      </div>
      {error && <p className="menu-description">{error}</p>}
      {!menu && !error && <p className="menu-description">Lade Speisekarte…</p>}
      {menu && (
        <div className="menu-list">
          {menu.categories.map((category) => (
            <section className="menu-category" key={category.category}>
              <h2>{category.category}</h2>
              {category.description && <p className="menu-description">{category.description}</p>}
              <ul>
                {category.flavours.map((flavour) => (
                  <li key={flavour.name}>
                    <span className="menu-flavour">
                      {flavour.name}
                      {flavour.allergens.length > 0 && <small> ({flavour.allergens.join(", ")})</small>}
                    </span>
                    <span className="menu-price">{euro(flavour.price)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {Object.keys(menu.allergenLegend).length > 0 && (
            <p className="menu-allergens">
              <strong>Allergene: </strong>
              {Object.entries(menu.allergenLegend).map(([key, label]) => `${key} = ${label}`).join(" · ")}
            </p>
          )}
        </div>
      )}
      <p className="menu-description">
        <a href={pdfUrl} target="_blank" rel="noreferrer">Speisekarte als PDF öffnen</a>
      </p>
    </section>
  );
}

/**
 * Impressum page mandated by German law (§ 5 TMG / § 18 MStV).
 *
 * Every block renders only when its field is filled in, because inventing placeholder legal data would
 * be wrong. The dispute-resolution paragraph and the EU ODR platform link are always shown: they are
 * required, and the stored `disputeResolution` sentence is appended when present.
 *
 * @param {{ content: object }} props Legal fields come from `content.impressum` and `content.address`.
 */
function ImpressumPage({ content }) {
  const impressum = content.impressum || {};
  const addressLines = String(content.address || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneRaw = String(content.phone || "").replace(/\s/g, "");

  return (
    <section className="page page-impressum">
      <h1>Impressum</h1>
      <p className="menu-description">
        Angaben gemäß § 5 TMG / § 18 MStV für {content.restaurantName}.
      </p>

      <div className="panel impressum-block">
        <h2>Angaben gemäß § 5 TMG</h2>
        <p>
          <strong>{content.restaurantName}</strong>
        </p>
        {impressum.ownerName ? <p>{impressum.ownerName}</p> : null}
        {addressLines.length ? addressLines.map((line) => <p key={line}>{line}</p>) : null}

        {content.phone ? (
          <p>
            Telefon: <a href={`tel:${phoneRaw}`}>{content.phone}</a>
          </p>
        ) : null}
        {impressum.email ? (
          <p>
            E-Mail: <a href={`mailto:${impressum.email}`}>{impressum.email}</a>
          </p>
        ) : null}
      </div>

      <div className="panel impressum-block">
        <h2>Vertreten durch</h2>
        {impressum.managingDirector ? (
          <p>
            <strong>Geschäftsführer / Inhaber:</strong> {impressum.managingDirector}
          </p>
        ) : (
          <p>{impressum.ownerName}</p>
        )}
        {content.taxId ? <p>USt-IdNr.: {content.taxId}</p> : null}
        {impressum.taxNumber ? <p>Steuernummer: {impressum.taxNumber}</p> : null}
      </div>

      {(impressum.registerCourt || impressum.registryNumber) ? (
        <div className="panel impressum-block">
          <h2>Registereintrag</h2>
          {impressum.registerCourt ? <p>Registergericht: {impressum.registerCourt}</p> : null}
          {impressum.registryNumber ? <p>Registernummer: {impressum.registryNumber}</p> : null}
        </div>
      ) : null}

      <div className="panel impressum-block">
        <h2>Streitschlichtung</h2>
        <p>
          Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:{" "}
          <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer">
            https://ec.europa.eu/consumers/odr
          </a>
          .
        </p>
        {impressum.disputeResolution ? <p>{impressum.disputeResolution}</p> : null}
      </div>
    </section>
  );
}

/**
 * Admin login: verifies the token against `/api/admin/auth` before storing it.
 *
 * The server is the only judge of the token; the value is written to `sessionStorage` (tab-scoped, not
 * a cookie) only after it is accepted, and the token never appears in the URL. A rejected or failed
 * check leaves the stored token untouched so the admin can correct a typo.
 */
function AdminAuthPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * Submits the token, and on success stores it and moves to the edit page.
   *
   * @param {import('react').FormEvent} event Submit event from the login form.
   */
  async function handleUnlock(event) {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const response = await fetch("/api/admin/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ token })
      });

      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Token-Prufung fehlgeschlagen");
      }

      sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
      navigate("/admin/edit");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page page-admin">
      <h1>Admin Login</h1>
      <p className="menu-description">
        Bitte den verschlusselten Admin-Token eingeben. Nach erfolgreicher Prufung wirst du zur Edit-Seite
        weitergeleitet.
      </p>
      <form className="panel admin-auth" onSubmit={handleUnlock}>
        <label htmlFor="token">Encrypted Auth Token</label>
        <input
          id="token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Token eingeben"
          required
        />
        <button type="submit" disabled={saving}>
          Weiter zur Edit-Seite
        </button>
      </form>
      {error ? <p className="state-error">{error}</p> : null}
    </section>
  );
}

/**
 * Admin editor: content fields, customer list, and menu PDF upload, all behind the admin token.
 *
 * Guards itself: on mount it re-validates the stored token with `/api/admin/auth` and clears it when
 * the server rejects it, so a token revoked server-side cannot keep the form open. While that check
 * runs, a placeholder is shown instead of the form, and without a token the route redirects to
 * `/admin`.
 *
 * Saving sends the whole content document back to `PUT /api/admin/content`; the server normalises it
 * and fills blanks from the defaults, so this form only has to collect the fields it shows.
 *
 * @param {{ content: object, onUpdated: () => Promise<void> }} props `onUpdated` re-fetches content so
 *   the shell and other pages pick up the change.
 */
function AdminEditPage({ content, onUpdated }) {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [authChecking, setAuthChecking] = useState(true);
  const [formState, setFormState] = useState(initialFormState);
  const [uploadFile, setUploadFile] = useState(null);
  const [customersText, setCustomersText] = useState("");
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function validateToken() {
      if (!token) {
        if (mounted) {
          setAuthChecking(false);
        }
        return;
      }

      try {
        const response = await fetch("/api/admin/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          sessionStorage.removeItem(ADMIN_TOKEN_KEY);
          setToken("");
        }
      } catch {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        setToken("");
      } finally {
        if (mounted) {
          setAuthChecking(false);
        }
      }
    }

    validateToken();

    return () => {
      mounted = false;
    };
  }, [token]);

  useEffect(() => {
    setFormState({
      restaurantName: content.restaurantName || "",
      logoUrl: content.logoUrl || "/images/",
      entranceImageUrl: content.entranceImageUrl || "/images/entrance.png",
      cuisine: content.cuisine || "",
      description: content.description || "",
      address: content.address || "",
      phone: content.phone || "",
      mobile: content.mobile || "",
      taxId: content.taxId || "",
      timing: content.timing || "",
      offersText: Array.isArray(content.offers) ? content.offers.join("\n") : "",
      instagram: content.social?.instagram || "",
      facebook: content.social?.facebook || "",
      wolt: content.delivery?.wolt || "",
      lieferando: content.delivery?.lieferando || "",
      fritzKola: content.drinks?.fritzKola || "",
      googlePlaceId: content.googleReviews?.placeId || "",
      googlePlaceName: content.googleReviews?.placeName || "",
      impressumOwnerName: content.impressum?.ownerName || "",
      impressumEmail: content.impressum?.email || "",
      impressumManagingDirector: content.impressum?.managingDirector || "",
      impressumRegisterCourt: content.impressum?.registerCourt || "",
      impressumRegistryNumber: content.impressum?.registryNumber || "",
      impressumTaxNumber: content.impressum?.taxNumber || "",
      impressumDisputeResolution: content.impressum?.disputeResolution || ""
    });
  }, [content]);

  const parsedOffers = useMemo(
    () =>
      formState.offersText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [formState.offersText]
  );

  /**
   * Applies one field edit to the form state.
   *
   * Driven by the input's `name`, so the same handler serves every text input and textarea; the form
   * state keys match the input names in `initialFormState`.
   */
  function updateField(event) {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  }

  /**
   * Saves the edited content and refreshes the shell.
   *
   * Newline-separated fields are split just before sending, so the API receives arrays rather than
   * the text the admin typed. A failed save leaves the form values in place (nothing is reset) so the
   * work is not lost; on success `onUpdated` re-fetches content.
   *
   * @param {import('react').FormEvent} event Submit event from the content form.
   */
  async function handleSaveContent(event) {
    event.preventDefault();
    setStatus("");
    setError("");
    setSaving(true);

    try {
      const response = await fetch("/api/admin/content", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          restaurantName: formState.restaurantName,
          logoUrl: formState.logoUrl,
          entranceImageUrl: formState.entranceImageUrl,
          cuisine: formState.cuisine,
          description: formState.description,
          address: formState.address,
          phone: formState.phone,
          mobile: formState.mobile,
          taxId: formState.taxId,
          timing: formState.timing,
          offers: parsedOffers,
          social: {
            instagram: formState.instagram,
            facebook: formState.facebook
          },
          delivery: {
            wolt: formState.wolt,
            lieferando: formState.lieferando
          },
          drinks: {
            fritzKola: formState.fritzKola
          },
          googleReviews: {
            placeId: formState.googlePlaceId,
            placeName: formState.googlePlaceName,
            reviews: content.googleReviews?.reviews || []
          },
          impressum: {
            ownerName: formState.impressumOwnerName,
            email: formState.impressumEmail,
            managingDirector: formState.impressumManagingDirector,
            registerCourt: formState.impressumRegisterCourt,
            registryNumber: formState.impressumRegistryNumber,
            taxNumber: formState.impressumTaxNumber,
            disputeResolution: formState.impressumDisputeResolution
          }
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Speichern fehlgeschlagen");
      }

      setStatus("Inhalte erfolgreich aktualisiert.");
      await onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    fetch("/api/admin/customers", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Kundenliste konnte nicht geladen werden.");
        setCustomersText(result.customers.join("\n"));
        setCustomersLoaded(true);
      })
      .catch((err) => setError(err.message));
  }, [token]);

  /**
   * Saves the customer list, splitting the textarea on newlines, commas and semicolons.
   *
   * The server replaces the whole list and echoes back the normalised result, which is written back
   * into the textarea so the admin sees exactly what was stored (trimmed, de-duplicated).
   *
   * @param {import('react').FormEvent} event Submit event from the customer form.
   */
  async function handleCustomersSave(event) {
    event.preventDefault();
    setStatus("");
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/admin/customers", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customers: customersText.split(/[\n,;]+/) })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Speichern fehlgeschlagen");
      setCustomersText(result.customers.join("\n"));
      setStatus(`Kundenliste gespeichert (${result.customers.length} Kunden).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Uploads the selected PDF as the new menu.
   *
   * Sends `multipart/form-data` with the file in the `menu` field; the token header is set explicitly
   * because the browser must choose the multipart boundary itself. On success the shell is refreshed
   * so the `menuUpdatedAt` shown to visitors changes.
   *
   * @param {import('react').FormEvent} event Submit event from the upload form.
   */
  async function handleMenuUpload(event) {
    event.preventDefault();
    setStatus("");
    setError("");

    if (!uploadFile) {
      setError("Bitte zuerst eine PDF-Datei auswahlen.");
      return;
    }

    setSaving(true);
    const formData = new FormData();
    formData.append("menu", uploadFile);

    try {
      const response = await fetch("/api/admin/menu", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Upload fehlgeschlagen");
      }

      setStatus("Neue Speisekarte wurde hochgeladen.");
      await onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Forgets the admin token and returns to the login page.
   *
   * Uses `replace` so the edit URL is not left in the history behind the login screen.
   */
  function handleLogout() {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    navigate("/admin", { replace: true });
  }

  if (authChecking) {
    return (
      <section className="page page-admin">
        <p className="state-text">Token wird gepruft ...</p>
      </section>
    );
  }

  if (!token) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <section className="page page-admin">
      <h1>Admin Edit</h1>
      <p className="menu-description">
        Inhalte bearbeiten und Speisekarte ersetzen. Der Zugang ist bereits token-validiert.
      </p>

      <div className="admin-toolbar">
        <Link className="orders-back" to="/currentOrders">Aktuelle Bestellungen</Link>
        <button type="button" className="ghost-btn" onClick={handleLogout}>
          Abmelden
        </button>
      </div>

      <form className="panel admin-form" onSubmit={handleSaveContent}>
        <h2>Home Inhalte</h2>

        <label htmlFor="restaurantName">Restaurant Name</label>
        <input
          id="restaurantName"
          name="restaurantName"
          value={formState.restaurantName}
          onChange={updateField}
          required
        />

        <label htmlFor="logoUrl">Logo URL</label>
        <input id="logoUrl" name="logoUrl" value={formState.logoUrl} onChange={updateField} />

        <label htmlFor="entranceImageUrl">Eingangsbild URL</label>
        <input
          id="entranceImageUrl"
          name="entranceImageUrl"
          value={formState.entranceImageUrl}
          onChange={updateField}
        />

        <label htmlFor="cuisine">Indische Kuche</label>
        <input id="cuisine" name="cuisine" value={formState.cuisine} onChange={updateField} />

        <label htmlFor="description">Beschreibung</label>
        <textarea id="description" name="description" value={formState.description} onChange={updateField} rows={4} />

        <label htmlFor="address">Adresse</label>
        <textarea
          id="address"
          name="address"
          value={formState.address}
          onChange={updateField}
          rows={3}
          required
        />

        <label htmlFor="phone">Telefon</label>
        <input id="phone" name="phone" value={formState.phone} onChange={updateField} />

        <label htmlFor="mobile">Mobil</label>
        <input id="mobile" name="mobile" value={formState.mobile} onChange={updateField} />

        <label htmlFor="taxId">USt-ID / Steuernummer (EU)</label>
        <input
          id="taxId"
          name="taxId"
          value={formState.taxId}
          onChange={updateField}
          placeholder="z. B. DE123456789"
        />

        <label htmlFor="timing">Offnungszeiten</label>
        <textarea id="timing" name="timing" value={formState.timing} onChange={updateField} rows={3} required />

        <label htmlFor="offersText">Upcoming Offers (eine Zeile pro Angebot)</label>
        <textarea
          id="offersText"
          name="offersText"
          value={formState.offersText}
          onChange={updateField}
          rows={5}
        />

        <label htmlFor="instagram">Instagram URL</label>
        <input id="instagram" name="instagram" value={formState.instagram} onChange={updateField} />

        <label htmlFor="facebook">Facebook URL</label>
        <input id="facebook" name="facebook" value={formState.facebook} onChange={updateField} />

        <label htmlFor="wolt">Wolt URL</label>
        <input id="wolt" name="wolt" value={formState.wolt} onChange={updateField} />
        
        <label htmlFor="lieferando">Lieferando URL</label>
        <input id="lieferando" name="lieferando" value={formState.lieferando} onChange={updateField} />

        <label htmlFor="fritzKola">Fritz-Kola URL</label>
        <input id="fritzKola" name="fritzKola" value={formState.fritzKola} onChange={updateField} />

        <label htmlFor="googlePlaceId">Google Place ID (optional, fur Live-Bewertungen)</label>
        <input id="googlePlaceId" name="googlePlaceId" value={formState.googlePlaceId} onChange={updateField} />

        <label htmlFor="googlePlaceName">Google Place Name (Anzeige)</label>
        <input
          id="googlePlaceName"
          name="googlePlaceName"
          value={formState.googlePlaceName}
          onChange={updateField}
        />

        <h2>Impressum</h2>

        <label htmlFor="impressumOwnerName">Inhaber / Ansprechpartner</label>
        <input
          id="impressumOwnerName"
          name="impressumOwnerName"
          value={formState.impressumOwnerName}
          onChange={updateField}
        />

        <label htmlFor="impressumEmail">E-Mail (Impressum)</label>
        <input
          id="impressumEmail"
          name="impressumEmail"
          value={formState.impressumEmail}
          onChange={updateField}
          placeholder="info@spiceanker.de"
        />

        <label htmlFor="impressumManagingDirector">Geschäftsführer / Inhaber (Vertreten durch)</label>
        <input
          id="impressumManagingDirector"
          name="impressumManagingDirector"
          value={formState.impressumManagingDirector}
          onChange={updateField}
        />

        <label htmlFor="impressumRegisterCourt">Registergericht</label>
        <input
          id="impressumRegisterCourt"
          name="impressumRegisterCourt"
          value={formState.impressumRegisterCourt}
          onChange={updateField}
          placeholder="z. B. Amtsgericht Hamburg"
        />

        <label htmlFor="impressumRegistryNumber">Registernummer (z. B. HRB)</label>
        <input
          id="impressumRegistryNumber"
          name="impressumRegistryNumber"
          value={formState.impressumRegistryNumber}
          onChange={updateField}
        />

        <label htmlFor="impressumTaxNumber">Steuernummer</label>
        <input
          id="impressumTaxNumber"
          name="impressumTaxNumber"
          value={formState.impressumTaxNumber}
          onChange={updateField}
        />

        <label htmlFor="impressumDisputeResolution">Streitschlichtung Hinweis</label>
        <textarea
          id="impressumDisputeResolution"
          name="impressumDisputeResolution"
          value={formState.impressumDisputeResolution}
          onChange={updateField}
          rows={3}
        />

        <button type="submit" disabled={saving}>
          Inhalte speichern
        </button>
      </form>

      <form className="panel admin-upload" onSubmit={handleCustomersSave}>
        <h2>Kundenliste</h2>
        <label htmlFor="customersText">Kundennummern (eine pro Zeile)</label>
        <textarea
          id="customersText"
          value={customersText}
          onChange={(event) => setCustomersText(event.target.value)}
          rows={10}
          disabled={!customersLoaded}
        />
        <button type="submit" disabled={saving || !customersLoaded}>
          Kundenliste speichern
        </button>
      </form>

      <form className="panel admin-upload" onSubmit={handleMenuUpload}>
        <h2>Menu PDF ersetzen</h2>
        <input
          type="file"
          accept="application/pdf"
          onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
        />
        <button type="submit" disabled={saving}>
          PDF hochladen
        </button>
      </form>

      {status ? <p className="state-success">{status}</p> : null}
      {error ? <p className="state-error">{error}</p> : null}
    </section>
  );
}

/**
 * GDPR cookie banner and preferences dialog.
 *
 * Stores the decision in `localStorage` (not `sessionStorage`) so it persists across visits, and the
 * banner only appears while no decision exists. "Essential" is always on and not togglable; analytics
 * and marketing default to off, so doing nothing is the privacy-preserving choice. Nothing on this site
 * currently reads the optional flags — the dialog exists to collect a valid consent record
 * (`essential`, `analytics`, `marketing`, `updatedAt`).
 */
function CookieConsent() {
  const storageKey = "cookieConsentV1";
  const [bannerVisible, setBannerVisible] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState({
    essential: true,
    analytics: false,
    marketing: false
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) {
        setBannerVisible(true);
        return;
      }

      const parsed = JSON.parse(stored);
      setPrefs({
        essential: true,
        analytics: Boolean(parsed.analytics),
        marketing: Boolean(parsed.marketing)
      });
    } catch {
      setBannerVisible(true);
    }
  }, []);

  /**
   * Saves a consent decision, closes the banner and the dialog.
   *
   * `essential` is forced to `true` regardless of input, and `updatedAt` records when consent was
   * given — the audit trail GDPR documentation expects.
   *
   * @param {{ essential: boolean, analytics: boolean, marketing: boolean }} nextPrefs
   */
  function persist(nextPrefs) {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...nextPrefs,
        essential: true,
        updatedAt: new Date().toISOString()
      })
    );
    setPrefs(nextPrefs);
    setBannerVisible(false);
    setPrefsOpen(false);
  }

  /** Consents to every category. */
  function acceptAll() {
    persist({ essential: true, analytics: true, marketing: true });
  }

  /** Rejects everything optional, the same state as leaving the banner untouched. */
  function rejectOptional() {
    persist({ essential: true, analytics: false, marketing: false });
  }

  /** Stores the categories as toggled in the dialog. */
  function saveCustom() {
    persist(prefs);
  }

  return (
    <>
      {bannerVisible ? (
        <aside className="cookie-banner" role="dialog" aria-live="polite" aria-label="Cookie Einstellungen">
          <h3>Cookie Einstellungen</h3>
          <p>
            Wir verwenden essenzielle Cookies fur den Betrieb der Website. Optionale Cookies helfen uns,
            Nutzung zu analysieren und Angebote zu personalisieren.
          </p>
          <div className="cookie-actions">
            <button type="button" onClick={acceptAll}>
              Alle akzeptieren
            </button>
            <button type="button" className="ghost-btn" onClick={rejectOptional}>
              Nur essenzielle
            </button>
            <button type="button" className="ghost-btn" onClick={() => setPrefsOpen(true)}>
              Einstellungen
            </button>
          </div>
        </aside>
      ) : null}

      <button type="button" className="cookie-manage" onClick={() => setPrefsOpen(true)}>
        Cookie Einstellungen
      </button>

      {prefsOpen ? (
        <section className="cookie-modal" role="dialog" aria-modal="true" aria-label="Cookie Details">
          <div className="cookie-modal-card">
            <h3>Datenschutz und Cookies (GDPR)</h3>
            <p>
              Essenzielle Cookies sind fur die Website zwingend. Du kannst optionale Kategorien jederzeit
              aktivieren oder deaktivieren.
            </p>
            <label>
              <input type="checkbox" checked disabled /> Essenziell (immer aktiv)
            </label>
            <label>
              <input
                type="checkbox"
                checked={prefs.analytics}
                onChange={(event) => setPrefs((prev) => ({ ...prev, analytics: event.target.checked }))}
              />
              Analyse
            </label>
            <label>
              <input
                type="checkbox"
                checked={prefs.marketing}
                onChange={(event) => setPrefs((prev) => ({ ...prev, marketing: event.target.checked }))}
              />
              Marketing
            </label>
            <div className="cookie-actions">
              <button type="button" onClick={saveCustom}>
                Auswahl speichern
              </button>
              <button type="button" className="ghost-btn" onClick={() => setPrefsOpen(false)}>
                Schliessen
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

export default App;
