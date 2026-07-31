import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
const port = process.env.PORT || 4000;
const adminTokenHash = process.env.ADMIN_TOKEN_HASH || hashToken(process.env.ADMIN_TOKEN || 'demo-admin-token');

const storageDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../storage');
const contentFilePath = path.join(storageDir, 'content.json');
const menuFilePath = path.join(storageDir, 'menu.pdf');
const webDistDir = path.resolve(__dirname, '../../web/dist');

const defaultContent = {
  restaurantName: 'Spice Anker',
  logoUrl: '/images/spice-anker-logo.png',
  entranceImageUrl: '/images/entrance.png',
  chefName: 'Chef Sachin',
  chefBio:
    'Koch Sachin ist ein ehemaliger Seemann mit langjähriger Erfahrung in der authentischen indischen Küche. Mit seiner Leidenschaft für traditionelle Aromen und seiner Fähigkeit, köstliche Gerichte zuzubereiten, bringt er Disziplin, Hingabe und hohe Qualitätsansprüche in die Küche. In seiner Freizeit ist er ein begeisterter Cricket-Fan.',
  chefImageUrl: '/images/chef-profile.jpeg',
  cuisine: 'Authentische indische Kuche',
  description:
    'Willkommen in unserem indischen Restaurant in Hamburg, wo authentische Aromen auf herzliche Gastfreundschaft treffen. Wir servieren köstliche, frisch zubereitete Gerichte, inspiriert von Indiens reicher kulinarischer Kultur, und bieten gleichzeitig Speisen an, die den deutschen Geschmack und die Vorlieben berücksichtigen. Von aromatischen Currys und Tandoori-Spezialitäten bis hin zu ausgewogenen, wohltuenden Gerichten verbindet unsere Speisekarte Tradition, Qualität und ein modernes kulinarisches Erlebnis',
  address: 'Wendenstraße 197\n20537 Hamburg',
  phone: '040/410 99 598',
  mobile: '0176/476 480 78',
  timing: 'Mo. - Do. 11:00 - 21:00 Uhr\nFr. 12:00 - 21:00 Uhr\nSa. So. & Feiertage: 12:00 - 21:00 Uhr',
  dishImages: ['/images/mango-sauce.png', '/images/biryani.png', '/images/masala-chai.png'],
  dishCaptions: ['Mango Sauce', 'Biryani', 'Masala Chai'],
  offers: ['Mittwoch Tandoori Night: 20% auf alle Tandoori-Platten', 'Family Sunday Brunch mit Live-Chaat-Station'],
  social: {
    instagram: 'https://instagram.com/rangmahal.muc',
    facebook: 'https://facebook.com/rangmahal.muc',
  },
  delivery: {
    wolt: 'https://wolt.com',
    uberEats: 'https://www.ubereats.com/de',
    lieferando: 'https://www.lieferando.de',
  },
  drinks: {
    fritzKola: 'https://fritz-kola.com/de',
  },
  googleReviews: {
    placeId: '',
    placeName: '',
    fetchedAt: null,
    reviews: [
      {
        authorName: 'Julia M.',
        rating: 5,
        text: 'Sehr freundliches Team, tolles Ambiente und richtig gutes Butter Chicken.',
        relativeTimeDescription: 'vor 2 Wochen',
        profilePhotoUrl: '',
      },
      {
        authorName: 'Kai R.',
        rating: 5,
        text: 'Authentischer Geschmack und schnelle Lieferung. Komme gerne wieder.',
        relativeTimeDescription: 'vor 1 Monat',
        profilePhotoUrl: '',
      },
      {
        authorName: 'Selin A.',
        rating: 4,
        text: 'Sehr leckeres Biryani und nette Beratung bei der Auswahl.',
        relativeTimeDescription: 'vor 1 Monat',
        profilePhotoUrl: '',
      },
    ],
  },
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
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

function readString(value, fallback = '') {
  if (value === undefined || value === null) {
    return String(fallback).trim();
  }

  return String(value).trim();
}

function normalizeContent(payload = {}) {
  const incomingGoogleReviews = payload.googleReviews || {};
  const normalizedReviews = Array.isArray(incomingGoogleReviews.reviews)
    ? incomingGoogleReviews.reviews
        .map((item) => ({
          authorName: readString(item?.authorName),
          rating: Math.max(1, Math.min(5, Number(item?.rating) || 5)),
          text: readString(item?.text),
          relativeTimeDescription: readString(item?.relativeTimeDescription),
          profilePhotoUrl: readString(item?.profilePhotoUrl),
        }))
        .filter((item) => item.authorName && item.text)
    : defaultContent.googleReviews.reviews;

  return {
    restaurantName: readString(payload.restaurantName, defaultContent.restaurantName),
    logoUrl: readString(payload.logoUrl, defaultContent.logoUrl),
    entranceImageUrl: readString(payload.entranceImageUrl, defaultContent.entranceImageUrl),
    chefName: readString(payload.chefName, defaultContent.chefName),
    chefBio: readString(payload.chefBio, defaultContent.chefBio),
    chefImageUrl: readString(payload.chefImageUrl, defaultContent.chefImageUrl),
    cuisine: readString(payload.cuisine, defaultContent.cuisine),
    description: readString(payload.description, defaultContent.description),
    address: readString(payload.address, defaultContent.address),
    phone: readString(payload.phone, defaultContent.phone),
    mobile: readString(payload.mobile, defaultContent.mobile),
    timing: readString(payload.timing, defaultContent.timing),
    dishImages: Array.isArray(payload.dishImages)
      ? payload.dishImages.map(item => String(item).trim()).filter(Boolean)
      : defaultContent.dishImages,
    dishCaptions: Array.isArray(payload.dishCaptions)
      ? payload.dishCaptions.map(item => String(item).trim()).filter(Boolean)
      : defaultContent.dishCaptions,
    offers: Array.isArray(payload.offers)
      ? payload.offers.map(item => String(item).trim()).filter(Boolean)
      : defaultContent.offers,
    social: {
      instagram: readString(payload.social?.instagram, defaultContent.social.instagram),
      facebook: readString(payload.social?.facebook, defaultContent.social.facebook),
    },
    delivery: {
      wolt: readString(payload.delivery?.wolt, defaultContent.delivery.wolt),
      uberEats: readString(payload.delivery?.uberEats, defaultContent.delivery.uberEats),
      lieferando: readString(payload.delivery?.lieferando, defaultContent.delivery.lieferando),
    },
    drinks: {
      fritzKola: readString(payload.drinks?.fritzKola, defaultContent.drinks.fritzKola),
    },
    googleReviews: {
      placeId: readString(incomingGoogleReviews.placeId, defaultContent.googleReviews.placeId),
      placeName: readString(incomingGoogleReviews.placeName, defaultContent.googleReviews.placeName),
      fetchedAt: readString(incomingGoogleReviews.fetchedAt, defaultContent.googleReviews.fetchedAt),
      reviews: normalizedReviews,
    },
  };
}

function mapGooglePlaceReviewToContentReview(review = {}) {
  return {
    authorName: readString(review.author_name),
    rating: Math.max(1, Math.min(5, Number(review.rating) || 5)),
    text: readString(review.text),
    relativeTimeDescription: readString(review.relative_time_description),
    profilePhotoUrl: readString(review.profile_photo_url),
  };
}

async function fetchGooglePlaceReviews(placeId) {
  const apiKey = readString(process.env.GOOGLE_PLACES_API_KEY);
  if (!apiKey || !placeId) {
    return null;
  }

  const endpoint = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  endpoint.searchParams.set('place_id', placeId);
  endpoint.searchParams.set('fields', 'name,reviews');
  endpoint.searchParams.set('reviews_sort', 'newest');
  endpoint.searchParams.set('key', apiKey);

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Google Places request failed with ${response.status}`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK') {
    throw new Error(payload.error_message || `Google Places returned status ${payload.status}`);
  }

  const result = payload.result || {};
  const reviews = Array.isArray(result.reviews)
    ? result.reviews.map(mapGooglePlaceReviewToContentReview).filter((item) => item.authorName && item.text)
    : [];

  return {
    placeId,
    placeName: readString(result.name),
    fetchedAt: new Date().toISOString(),
    reviews,
  };
}

function ensureStorage() {
  fs.mkdirSync(storageDir, { recursive: true });

  if (!fs.existsSync(contentFilePath)) {
    fs.writeFileSync(contentFilePath, JSON.stringify(defaultContent, null, 2), 'utf-8');
  }
}

function readContent() {
  const raw = fs.readFileSync(contentFilePath, 'utf-8');
  const data = normalizeContent(JSON.parse(raw));
  let menuUpdatedAt = null;

  if (fs.existsSync(menuFilePath)) {
    menuUpdatedAt = fs.statSync(menuFilePath).mtime.toISOString();
  }

  return {
    ...data,
    menuUrl: '/menu.pdf',
    menuUpdatedAt,
  };
}

function writeContent(data) {
  fs.writeFileSync(contentFilePath, JSON.stringify(data, null, 2), 'utf-8');
}

function requireAdminToken(req, res, next) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  if (!isTokenValid(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdfMime = file.mimetype === 'application/pdf';
    const isPdfName = file.originalname.toLowerCase().endsWith('.pdf');

    if (!isPdfMime && !isPdfName) {
      cb(new Error('Only PDF files are allowed'));
      return;
    }

    cb(null, true);
  },
});

ensureStorage();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(webDistDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/content', (_req, res) => {
  res.json(readContent());
});

app.get('/api/reviews', async (_req, res) => {
  const content = readContent();
  const placeId = readString(content.googleReviews?.placeId);

  try {
    const liveReviews = await fetchGooglePlaceReviews(placeId);
    if (liveReviews) {
      return res.json(liveReviews);
    }
  } catch (error) {
    console.error('Could not fetch Google reviews:', error.message);
  }

  return res.json(content.googleReviews || defaultContent.googleReviews);
});

app.post('/api/admin/auth', (req, res) => {
  const token = String(req.body?.token || '');
  if (!isTokenValid(token)) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }

  return res.json({ ok: true });
});

app.put('/api/admin/content', requireAdminToken, (req, res) => {
  const payload = req.body || {};

  const updatedContent = normalizeContent(payload);

  if (!updatedContent.restaurantName || !updatedContent.address || !updatedContent.timing) {
    return res.status(400).json({
      error: 'restaurantName, address and timing are required',
    });
  }

  writeContent(updatedContent);
  return res.json(readContent());
});

app.post('/api/admin/menu', requireAdminToken, upload.single('menu'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing PDF file in field 'menu'" });
  }

  fs.writeFileSync(menuFilePath, req.file.buffer);
  return res.json({ ok: true, menuUrl: '/menu.pdf' });
});

app.get('/menu.pdf', (_req, res) => {
  if (!fs.existsSync(menuFilePath)) {
    return res.status(404).send('No menu PDF uploaded yet.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=menu.pdf');
  return res.sendFile(menuFilePath);
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (fs.existsSync(path.join(webDistDir, 'index.html'))) {
    return res.sendFile(path.join(webDistDir, 'index.html'));
  }

  return res.status(503).send('Web build not found. Run npm run build first.');
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }

  return res.status(500).json({ error: 'Unexpected server error' });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
