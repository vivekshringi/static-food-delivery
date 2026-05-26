import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";

const ADMIN_TOKEN_KEY = "adminTokenSessionV1";

const initialFormState = {
  restaurantName: "",
  logoUrl: "",
  chefName: "",
  chefBio: "",
  chefImageUrl: "",
  cuisine: "",
  description: "",
  address: "",
  timing: "",
  offersText: "",
  dishImagesText: "",
  instagram: "",
  facebook: "",
  x: "",
  wolt: "",
  lieferando: ""
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
          <img
            src={content?.logoUrl || "/images/spice-anker-logo.png"}
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
            <NavLink to="/admin">Admin</NavLink>
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
  const delivery = content.delivery || {};

  return (
    <section className="page page-home">
      <div className="hero">
        <img src={content.logoUrl || "/images/spice-anker-logo.png"} alt="Logo" className="hero-logo" />
        <p className="eyebrow">Contemporary Indian Kitchen</p>
        <h1>{content.restaurantName}</h1>
        <p>{content.description}</p>
        <div className="hero-actions">
          <Link className="hero-btn" to="/menu">
            Speisekarte ansehen
          </Link>
        </div>
      </div>

      <section className="media-grid">
        <article className="panel chef-profile">
          <h2>Chef Profil</h2>
          <div className="chef-content">
            <img
              src={content.chefImageUrl || "/images/chef-profile.svg"}
              alt={`Profilbild von ${content.chefName}`}
              className="chef-image"
            />
            <div>
              <h3>{content.chefName}</h3>
              <p>{content.chefBio || "Unser Chef bringt jahrzehntelange Erfahrung in moderner indischer Kuche mit."}</p>
            </div>
          </div>
        </article>

        <article className="panel dishes-gallery">
          <h2>Signature Dishes</h2>
          <div className="dish-grid">
            {dishImages.length ? (
              dishImages.map((imageUrl, index) => (
                <img key={`${imageUrl}-${index}`} src={imageUrl} alt={`Dish ${index + 1}`} className="dish-image" />
              ))
            ) : (
              <p>Derzeit sind keine Dish-Bilder hinterlegt.</p>
            )}
          </div>
        </article>
      </section>

      <div className="grid-details">
        <article className="panel">
          <h2>Chef</h2>
          <p>{content.chefName}</p>
        </article>
        <article className="panel">
          <h2>Kuche</h2>
          <p>{content.cuisine}</p>
        </article>
        <article className="panel">
          <h2>Adresse</h2>
          <p>{content.address}</p>
        </article>
        <article className="panel">
          <h2>Offnungszeiten</h2>
          <p>{content.timing}</p>
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
            <a href={delivery.wolt} target="_blank" rel="noreferrer" className="delivery-pill wolt">
              Wolt
            </a>
          ) : null}
          {delivery.lieferando ? (
            <a href={delivery.lieferando} target="_blank" rel="noreferrer" className="delivery-pill lieferando">
              Lieferando
            </a>
          ) : null}
        </div>
      </section>
    </section>
  );
}

function SiteFooter({ content }) {
  const social = content.social || {};
  const delivery = content.delivery || {};

  return (
    <footer className="site-footer">
      <div className="footer-column">
        <p>Folge uns fur neue Offers und Events:</p>
        <div className="social-links">
          {social.instagram ? (
            <a href={social.instagram} target="_blank" rel="noreferrer">
              Instagram
            </a>
          ) : null}
          {social.facebook ? (
            <a href={social.facebook} target="_blank" rel="noreferrer">
              Facebook
            </a>
          ) : null}
          {social.x ? (
            <a href={social.x} target="_blank" rel="noreferrer">
              X
            </a>
          ) : null}
        </div>
      </div>
      <div className="footer-column">
        <p>Lieferung:</p>
        <div className="social-links">
          {delivery.wolt ? (
            <a href={delivery.wolt} target="_blank" rel="noreferrer">
              Wolt
            </a>
          ) : null}
          {delivery.lieferando ? (
            <a href={delivery.lieferando} target="_blank" rel="noreferrer">
              Lieferando
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
      chefName: content.chefName || "",
      chefBio: content.chefBio || "",
      chefImageUrl: content.chefImageUrl || "",
      cuisine: content.cuisine || "",
      description: content.description || "",
      address: content.address || "",
      timing: content.timing || "",
      offersText: Array.isArray(content.offers) ? content.offers.join("\n") : "",
      dishImagesText: Array.isArray(content.dishImages) ? content.dishImages.join("\n") : "",
      instagram: content.social?.instagram || "",
      facebook: content.social?.facebook || "",
      x: content.social?.x || "",
      wolt: content.delivery?.wolt || "",
      lieferando: content.delivery?.lieferando || ""
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
          chefName: formState.chefName,
          chefBio: formState.chefBio,
          chefImageUrl: formState.chefImageUrl,
          cuisine: formState.cuisine,
          description: formState.description,
          address: formState.address,
          timing: formState.timing,
          dishImages: parsedDishImages,
          offers: parsedOffers,
          social: {
            instagram: formState.instagram,
            facebook: formState.facebook,
            x: formState.x
          },
          delivery: {
            wolt: formState.wolt,
            lieferando: formState.lieferando
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
        <input
          id="address"
          name="address"
          value={formState.address}
          onChange={updateField}
          required
        />

        <label htmlFor="timing">Offnungszeiten</label>
        <input id="timing" name="timing" value={formState.timing} onChange={updateField} required />

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

        <label htmlFor="instagram">Instagram URL</label>
        <input id="instagram" name="instagram" value={formState.instagram} onChange={updateField} />

        <label htmlFor="facebook">Facebook URL</label>
        <input id="facebook" name="facebook" value={formState.facebook} onChange={updateField} />

        <label htmlFor="x">X URL</label>
        <input id="x" name="x" value={formState.x} onChange={updateField} />

        <label htmlFor="wolt">Wolt URL</label>
        <input id="wolt" name="wolt" value={formState.wolt} onChange={updateField} />

        <label htmlFor="lieferando">Lieferando URL</label>
        <input id="lieferando" name="lieferando" value={formState.lieferando} onChange={updateField} />

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
