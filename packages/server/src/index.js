import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const app = express();
const port = process.env.PORT || 4000;
const adminTokenHash = process.env.ADMIN_TOKEN_HASH || hashToken(process.env.ADMIN_TOKEN || "demo-admin-token");

const storageDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "../storage");
const contentFilePath = path.join(storageDir, "content.json");
const menuFilePath = path.join(storageDir, "menu.pdf");
const webDistDir = path.resolve(__dirname, "../../web/dist");

const defaultContent = {
  restaurantName: "Spice Anker",
  logoUrl: "/images/spice-anker-logo.png",
  chefName: "Chef Sachin",
  chefBio:
    "Koch Sachin ist ein ehemaliger Seemann mit langjähriger Erfahrung in der authentischen indischen Küche. Mit seiner Leidenschaft für traditionelle Aromen und seiner Fähigkeit, köstliche Gerichte zuzubereiten, bringt er Disziplin, Hingabe und hohe Qualitätsansprüche in die Küche. In seiner Freizeit ist er ein begeisterter Cricket-Fan.",
  chefImageUrl: "/images/chef-profile.jpeg",
  cuisine: "Authentische indische Kuche",
  description:
    "Willkommen in unserem indischen Restaurant in Hamburg, wo authentische Aromen auf herzliche Gastfreundschaft treffen. Wir servieren köstliche, frisch zubereitete Gerichte, inspiriert von Indiens reicher kulinarischer Kultur, und bieten gleichzeitig Speisen an, die den deutschen Geschmack und die Vorlieben berücksichtigen. Von aromatischen Currys und Tandoori-Spezialitäten bis hin zu ausgewogenen, wohltuenden Gerichten verbindet unsere Speisekarte Tradition, Qualität und ein modernes kulinarisches Erlebnis",
  address: "Wendenstraße 197\n20537 Hamburg",
  phone: "040/410 995 598",
  mobile: "0176/476 480 78",
  timing: "Mo. - Do. 11:00 - 21:00 Uhr\nFr. 12:00 - 21:00 Uhr\nSa. So. & Feiertage: 12:00 - 21:00 Uhr",
  dishImages: [
    "/images/lamb-curry.jpeg",
    "/images/tofu.jpeg",
    "/images/mutter-paneer.jpeg",
    "/images/paneer.jpeg"
  ],
  offers: [
    "Mittwoch Tandoori Night: 20% auf alle Tandoori-Platten",
    "Family Sunday Brunch mit Live-Chaat-Station"
  ],
  social: {
    instagram: "https://instagram.com/rangmahal.muc",
    facebook: "https://facebook.com/rangmahal.muc",
    x: "https://x.com/rangmahal_muc"
  },
  delivery: {
    wolt: "https://wolt.com",
    lieferando: "https://www.lieferando.de"
  }
};

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function isTokenValid(token) {
  if (!token) {
    return false;
  }

  const incoming = hashToken(token);
  const expected = String(adminTokenHash);

  if (incoming.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
  } catch {
    return false;
  }
}

function normalizeContent(payload = {}) {
  return {
    restaurantName: String(payload.restaurantName || defaultContent.restaurantName).trim(),
    logoUrl: String(payload.logoUrl || defaultContent.logoUrl).trim(),
    chefName: String(payload.chefName || defaultContent.chefName).trim(),
    chefBio: String(payload.chefBio || defaultContent.chefBio).trim(),
    chefImageUrl: String(payload.chefImageUrl || defaultContent.chefImageUrl).trim(),
    cuisine: String(payload.cuisine || defaultContent.cuisine).trim(),
    description: String(payload.description || defaultContent.description).trim(),
    address: String(payload.address || defaultContent.address).trim(),
    phone: String(payload.phone || defaultContent.phone).trim(),
    mobile: String(payload.mobile || defaultContent.mobile).trim(),
    timing: String(payload.timing || defaultContent.timing).trim(),
    dishImages: Array.isArray(payload.dishImages)
      ? payload.dishImages.map((item) => String(item).trim()).filter(Boolean)
      : defaultContent.dishImages,
    offers: Array.isArray(payload.offers)
      ? payload.offers.map((item) => String(item).trim()).filter(Boolean)
      : defaultContent.offers,
    social: {
      instagram: String(payload.social?.instagram || defaultContent.social.instagram).trim(),
      facebook: String(payload.social?.facebook || defaultContent.social.facebook).trim(),
      x: String(payload.social?.x || defaultContent.social.x).trim()
    },
    delivery: {
      wolt: String(payload.delivery?.wolt || defaultContent.delivery.wolt).trim(),
      lieferando: String(payload.delivery?.lieferando || defaultContent.delivery.lieferando).trim()
    }
  };
}

function ensureStorage() {
  fs.mkdirSync(storageDir, { recursive: true });

  if (!fs.existsSync(contentFilePath)) {
    fs.writeFileSync(contentFilePath, JSON.stringify(defaultContent, null, 2), "utf-8");
  }
}

function readContent() {
  const raw = fs.readFileSync(contentFilePath, "utf-8");
  const data = normalizeContent(JSON.parse(raw));
  let menuUpdatedAt = null;

  if (fs.existsSync(menuFilePath)) {
    menuUpdatedAt = fs.statSync(menuFilePath).mtime.toISOString();
  }

  return {
    ...data,
    menuUrl: "/menu.pdf",
    menuUpdatedAt
  };
}

function writeContent(data) {
  fs.writeFileSync(contentFilePath, JSON.stringify(data, null, 2), "utf-8");
}

function requireAdminToken(req, res, next) {
  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!isTokenValid(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfName = file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPdfMime && !isPdfName) {
      cb(new Error("Only PDF files are allowed"));
      return;
    }

    cb(null, true);
  }
});

ensureStorage();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(webDistDir));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/content", (_req, res) => {
  res.json(readContent());
});

app.post("/api/admin/auth", (req, res) => {
  const token = String(req.body?.token || "");
  if (!isTokenValid(token)) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }

  return res.json({ ok: true });
});

app.put("/api/admin/content", requireAdminToken, (req, res) => {
  const payload = req.body || {};

  const updatedContent = normalizeContent(payload);

  if (!updatedContent.restaurantName || !updatedContent.address || !updatedContent.timing) {
    return res.status(400).json({
      error: "restaurantName, address and timing are required"
    });
  }

  writeContent(updatedContent);
  return res.json(readContent());
});

app.post(
  "/api/admin/menu",
  requireAdminToken,
  upload.single("menu"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing PDF file in field 'menu'" });
    }

    fs.writeFileSync(menuFilePath, req.file.buffer);
    return res.json({ ok: true, menuUrl: "/menu.pdf" });
  }
);

app.get("/menu.pdf", (_req, res) => {
  if (!fs.existsSync(menuFilePath)) {
    return res.status(404).send("No menu PDF uploaded yet.");
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=menu.pdf");
  return res.sendFile(menuFilePath);
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }

  if (fs.existsSync(path.join(webDistDir, "index.html"))) {
    return res.sendFile(path.join(webDistDir, "index.html"));
  }

  return res.status(503).send("Web build not found. Run npm run build first.");
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === "Only PDF files are allowed") {
    return res.status(400).json({ error: err.message });
  }

  return res.status(500).json({ error: "Unexpected server error" });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
