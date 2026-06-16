import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";

const ADMIN_TOKEN_KEY = "adminTokenSessionV1";
const ABSOLUTE_URL_PATTERN = /^(?:[a-z]+:)?\/\//i;

function buildGoogleMapsLocationQuery(address) {
  return String(address || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
}

function buildGoogleMapsEmbedUrl(address) {
  const query = buildGoogleMapsLocationQuery(address);
  return query ? `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : "";
}

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

function SafeImage({ src, fallbackSrc, ...props }) {
  const resolvedFallback = useMemo(() => resolveImageUrl(fallbackSrc, fallbackSrc), [fallbackSrc]);
  const [resolvedSrc, setResolvedSrc] = useState(() => resolveImageUrl(src, fallbackSrc));

  useEffect(() => {
    setResolvedSrc(resolveImageUrl(src, fallbackSrc));
  }, [src, fallbackSrc]);

  function handleError() {
    if (resolvedFallback && resolvedSrc !== resolvedFallback) {
      setResolvedSrc(resolvedFallback);
    }
  }

  return <img {...props} src={resolvedSrc} onError={handleError} />;
}

const initialFormState = {
  restaurantName: "",
  logoUrl: "",
  entranceImageUrl: "",
  chefName: "",
  chefBio: "",
  chefImageUrl: "",
  cuisine: "",
  description: "",
  address: "",
  phone: "",
  mobile: "",
  timing: "",
  offersText: "",
  dishImagesText: "",
  dishCaptionsText: "",
  instagram: "",
  facebook: "",
  wolt: "",
  uberEats: "",
  lieferando: "",
  fritzKola: ""
};

function App() {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

function HomePage({ content }) {
  const dishImages = Array.isArray(content.dishImages) ? content.dishImages : [];
  const dishCaptions = Array.isArray(content.dishCaptions) ? content.dishCaptions : [];
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

      <section className="panel dishes-showcase">
        <div className="dishes-head">
          <h2>Signature Dishes</h2>
          <p>Unsere beliebtesten Gerichte, frisch serviert und mit viel Geschmack.</p>
        </div>
        <div className="dish-grid signature-grid">
          {dishImages.length ? (
            dishImages.map((imageUrl, index) => (
              <figure className="dish-card" key={`${imageUrl}-${index}`}>
                <SafeImage
                  src={imageUrl}
                  fallbackSrc="/images/mango-sauce.png"
                  alt={`Dish ${index + 1}`}
                  className="dish-image"
                />
                <figcaption>{dishCaptions[index] || `Signature ${index + 1}`}</figcaption>
              </figure>
            ))
          ) : (
            <p>Derzeit sind keine Dish-Bilder hinterlegt.</p>
          )}
        </div>
      </section>

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
        <p>Bestelle unsere Gerichte bequem uber Wolt, Uber Eats und Lieferando.</p>
        <div className="delivery-links">
          {delivery.wolt ? (
            <a href={delivery.wolt} target="_blank" rel="noreferrer" className="delivery-icon-link" title="Wolt">
              <SafeImage src="/icons/wolt.png" fallbackSrc="/icons/wolt.png" alt="Wolt" className="delivery-icon" />
            </a>
          ) : null}
          {delivery.uberEats ? (
            <a
              href={delivery.uberEats}
              target="_blank"
              rel="noreferrer"
              className="delivery-icon-link"
              title="Uber Eats"
            >
              <SafeImage
                src="/icons/ubereats.png"
                fallbackSrc="/icons/ubereats.png"
                alt="Uber Eats"
                className="delivery-icon"
              />
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
      </div>
    </footer>
  );
}

function MenuPage({ content }) {
  const source = content.menuUrl || "/menu.pdf";
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 768px)").matches : false
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 768px)");
    const handleChange = (event) => setIsMobileViewport(event.matches);

    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  const pdfSource = `${source}#page=1&zoom=80`;

  return (
    <section className="page page-menu">
      <h1>Unsere Speisekarte</h1>
      <p className="menu-description">
        Die PDF wird direkt im Browser angezeigt. Auf Mobilgeraten kannst du bei Bedarf scrollen oder die
        Datei herunterladen. Fur bessere Lesbarkeit offnet die PDF auf Mobilgeraten mit hoherem Zoom.
      </p>

      <div className="pdf-frame-wrap">
        <iframe title="Restaurant Menu" src={pdfSource} className="pdf-frame" />
      </div>
    </section>
  );
}

function AdminAuthPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

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

function AdminEditPage({ content, onUpdated }) {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || "");
  const [authChecking, setAuthChecking] = useState(true);
  const [formState, setFormState] = useState(initialFormState);
  const [uploadFile, setUploadFile] = useState(null);
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
      chefName: content.chefName || "",
      chefBio: content.chefBio || "",
      chefImageUrl: content.chefImageUrl || "",
      cuisine: content.cuisine || "",
      description: content.description || "",
      address: content.address || "",
      phone: content.phone || "",
      mobile: content.mobile || "",
      timing: content.timing || "",
      offersText: Array.isArray(content.offers) ? content.offers.join("\n") : "",
      dishImagesText: Array.isArray(content.dishImages) ? content.dishImages.join("\n") : "",
      dishCaptionsText: Array.isArray(content.dishCaptions) ? content.dishCaptions.join("\n") : "",
      instagram: content.social?.instagram || "",
      facebook: content.social?.facebook || "",
      wolt: content.delivery?.wolt || "",
      uberEats: content.delivery?.uberEats || "",
      lieferando: content.delivery?.lieferando || "",
      fritzKola: content.drinks?.fritzKola || ""
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

  const parsedDishImages = useMemo(
    () =>
      formState.dishImagesText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [formState.dishImagesText]
  );

  const parsedDishCaptions = useMemo(
    () =>
      formState.dishCaptionsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [formState.dishCaptionsText]
  );

  function updateField(event) {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  }

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
          chefName: formState.chefName,
          chefBio: formState.chefBio,
          chefImageUrl: formState.chefImageUrl,
          cuisine: formState.cuisine,
          description: formState.description,
          address: formState.address,
          phone: formState.phone,
          mobile: formState.mobile,
          timing: formState.timing,
          dishImages: parsedDishImages,
          dishCaptions: parsedDishCaptions,
          offers: parsedOffers,
          social: {
            instagram: formState.instagram,
            facebook: formState.facebook
          },
          delivery: {
            wolt: formState.wolt,
            uberEats: formState.uberEats,
            lieferando: formState.lieferando
          },
          drinks: {
            fritzKola: formState.fritzKola
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

        <label htmlFor="chefName">Chef</label>
        <input id="chefName" name="chefName" value={formState.chefName} onChange={updateField} />

        <label htmlFor="chefBio">Chef Bio</label>
        <textarea id="chefBio" name="chefBio" value={formState.chefBio} onChange={updateField} rows={3} />

        <label htmlFor="chefImageUrl">Chef Bild URL</label>
        <input id="chefImageUrl" name="chefImageUrl" value={formState.chefImageUrl} onChange={updateField} />

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

        <label htmlFor="dishImagesText">Dish Bilder (eine URL pro Zeile)</label>
        <textarea
          id="dishImagesText"
          name="dishImagesText"
          value={formState.dishImagesText}
          onChange={updateField}
          rows={4}
        />

        <label htmlFor="dishCaptionsText">Dish Captions (eine Zeile pro Bild, gleiche Reihenfolge)</label>
        <textarea
          id="dishCaptionsText"
          name="dishCaptionsText"
          value={formState.dishCaptionsText}
          onChange={updateField}
          rows={4}
        />

        <label htmlFor="instagram">Instagram URL</label>
        <input id="instagram" name="instagram" value={formState.instagram} onChange={updateField} />

        <label htmlFor="facebook">Facebook URL</label>
        <input id="facebook" name="facebook" value={formState.facebook} onChange={updateField} />

        <label htmlFor="wolt">Wolt URL</label>
        <input id="wolt" name="wolt" value={formState.wolt} onChange={updateField} />

        <label htmlFor="uberEats">Uber Eats URL</label>
        <input id="uberEats" name="uberEats" value={formState.uberEats} onChange={updateField} />

        <label htmlFor="lieferando">Lieferando URL</label>
        <input id="lieferando" name="lieferando" value={formState.lieferando} onChange={updateField} />

        <label htmlFor="fritzKola">Fritz-Kola URL</label>
        <input id="fritzKola" name="fritzKola" value={formState.fritzKola} onChange={updateField} />

        <button type="submit" disabled={saving}>
          Inhalte speichern
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

  function acceptAll() {
    persist({ essential: true, analytics: true, marketing: true });
  }

  function rejectOptional() {
    persist({ essential: true, analytics: false, marketing: false });
  }

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
