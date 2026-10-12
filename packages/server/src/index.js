import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import cron from 'node-cron';
import { agent, getMenuForPeriod, getCustomerNumbers, saveCustomerNumbers } from '../../agent/agent.js';
import {
  capturePaypalOrder,
  createPaypalOrder,
  getAllPayments,
  getPayment,
  getPaypalClientId,
  updatePayment,
} from '../../agent/payments.js';
import { logConversation, logPayment } from '../../agent/logger.js';

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
const ordersFilePath = path.join(storageDir, 'orders.json');
const ordersBackupFilePath = path.join(storageDir, 'order.backup.json');
const legacyOrdersFilePath = path.resolve(__dirname, '../../agent/orders.json');
const webDistDir = path.resolve(__dirname, '../../web/dist');
const maxChatMessageLength = 1000;
const paymentReceivedMessage =
  '(System: the PayPal payment for this order was received successfully. Call finalize_order now and confirm the order to the customer.)';

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
  taxId: '',
  timing: 'Mo. - Do. 11:00 - 21:00 Uhr\nFr. 12:00 - 21:00 Uhr\nSa. So. & Feiertage: 12:00 - 21:00 Uhr',
  dishImages: ['/images/mango-sauce.png', '/images/biryani.png', '/images/masala-chai.png'],
  dishCaptions: ['Mango Sauce', 'Biryani', 'Masala Chai', 'Pani Puri', 'Pav Bhaji', 'Pakora', 'Samosa'],
  offers: ['Mittwoch Tandoori Night: 20% auf alle Tandoori-Platten', 'Family Sunday Brunch mit Live-Chaat-Station'],
  social: {
    instagram: 'https://instagram.com/rangmahal.muc',
    facebook: 'https://facebook.com/rangmahal.muc',
  },
  delivery: {
    wolt: 'https://wolt.com',
    lieferando: 'https://www.lieferando.de',
  },
  drinks: {
    fritzKola: 'https://fritz-kola.com/de',
  },
  impressum: {
    ownerName: 'Spice Anker (Inhaber)',
    email: 'info@spiceanker.de',
    managingDirector: '',
    registerCourt: 'Amtsgericht Hamburg',
    registryNumber: '',
    taxNumber: '',
    disputeResolution:
      'Wir sind nicht bereit, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
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
    taxId: readString(payload.taxId, defaultContent.taxId),
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
      lieferando: readString(payload.delivery?.lieferando, defaultContent.delivery.lieferando),
    },
    drinks: {
      fritzKola: readString(payload.drinks?.fritzKola, defaultContent.drinks.fritzKola),
    },
    impressum: {
      ownerName: readString(payload.impressum?.ownerName, defaultContent.impressum.ownerName),
      email: readString(payload.impressum?.email, defaultContent.impressum.email),
      managingDirector: readString(
        payload.impressum?.managingDirector,
        defaultContent.impressum.managingDirector
      ),
      registerCourt: readString(payload.impressum?.registerCourt, defaultContent.impressum.registerCourt),
      registryNumber: readString(payload.impressum?.registryNumber, defaultContent.impressum.registryNumber),
      taxNumber: readString(payload.impressum?.taxNumber, defaultContent.impressum.taxNumber),
      disputeResolution: readString(
        payload.impressum?.disputeResolution,
        defaultContent.impressum.disputeResolution
      ),
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

function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function basicCredentialsMatch(req, username, password) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return false;

  const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return (
    separator >= 0 &&
    constantTimeEqual(decoded.slice(0, separator), username) &&
    constantTimeEqual(decoded.slice(separator + 1), password)
  );
}

function requireChatCredentials(req, res, next) {
  const username = process.env.CHAT_USER;
  const password = process.env.CHAT_PASSWORD;
  if (!username || !password) {
    return res.status(503).json({ error: 'Chat authentication is not configured.' });
  }

  if (basicCredentialsMatch(req, username, password)) return next();

  return res.status(401).json({ error: 'Chat login is required.' });
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .join('');
}

function getChatStartMessage(acceptLanguage) {
  const german = String(acceptLanguage || '').toLowerCase().includes('de');
  return german
    ? '(The customer has just opened the chat. Begin in German (Deutsch).)'
    : '(The customer has just opened the chat. Begin in English.)';
}

async function readOrderFile(filePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Moves all current orders to the backup file, then empties orders.json.
export async function backupOrders() {
  const orders = await readOrderFile(ordersFilePath);
  if (orders.length === 0) return 0;
  const backup = await readOrderFile(ordersBackupFilePath);
  await fs.promises.writeFile(
    ordersBackupFilePath,
    JSON.stringify([...backup, ...orders], null, 2),
    'utf8'
  );
  await fs.promises.writeFile(ordersFilePath, '[]', 'utf8');
  console.log(`[backup] moved ${orders.length} order(s) to ${ordersBackupFilePath}`);
  return orders.length;
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

// Logs the tool calls and the reply the agent produced for the latest customer message.
async function logAgentTurn(threadId, messages, payment) {
  let start = messages.length - 1;
  while (start > 0 && messages[start]?.getType?.() !== 'human') start -= 1;
  for (const message of messages.slice(start + 1)) {
    const type = message.getType?.();
    if (type === 'ai') {
      for (const call of message.tool_calls || []) {
        await logConversation('tool_call', { threadId, tool: call.name, args: call.args });
      }
      const text = contentToText(message.content);
      if (text) await logConversation('agent_reply', { threadId, text });
    } else if (type === 'tool') {
      await logConversation('tool_result', {
        threadId,
        tool: message.name,
        result: contentToText(message.content),
      });
    }
  }
  if (payment) {
    await logPayment('chat_turn_payment_state', { threadId, status: payment.status, amount: payment.amount });
  }
}

function validThreadId(threadId) {
  return typeof threadId === 'string' && /^[0-9a-f-]{36}$/i.test(threadId);
}

app.post('/api/chat', requireChatCredentials, async (req, res) => {
  const { threadId, message, start, paymentCompleted } = req.body || {};
  if (!validThreadId(threadId)) {
    return res.status(400).json({ error: 'Ungültige Sitzung.' });
  }

  let text = start === true ? getChatStartMessage(req.get('accept-language')) : message;
  if (paymentCompleted === true) {
    const payment = await getPayment(threadId);
    if (payment?.status !== 'paid') {
      logPayment('return_without_confirmed_payment', { threadId, status: payment?.status ?? null });
      return res.status(402).json({ error: 'Die Zahlung wurde nicht bestätigt.' });
    }
    logPayment('return_from_paypal', { threadId, paypalOrderId: payment.paypalOrderId });
    text = paymentReceivedMessage;
  }
  if (typeof text !== 'string' || !text.trim() || text.length > maxChatMessageLength) {
    return res.status(400).json({ error: 'Ungültige Nachricht.' });
  }

  logConversation('user_message', {
    threadId,
    source: paymentCompleted === true ? 'system_payment_received' : start === true ? 'start' : 'customer',
    text: text.trim(),
  });

  try {
    const result = await agent.invoke(
      { messages: [{ role: 'user', content: text.trim() }] },
      { configurable: { thread_id: threadId } }
    );
    const lastMessage = result.messages[result.messages.length - 1];
    const payment = await getPayment(threadId);
    await logAgentTurn(threadId, result.messages, payment);
    return res.json({
      reply: contentToText(lastMessage.content),
      ...(payment?.status === 'pending'
        ? { payment: { amount: payment.amount, currency: payment.currency } }
        : {}),
    });
  } catch (error) {
    console.error('[chat] agent error:', error);
    logConversation('agent_error', { threadId, error: error.message });
    return res.status(500).json({ error: 'Die Nachricht konnte nicht verarbeitet werden.' });
  }
});

app.get('/api/paypal/config', requireChatCredentials, (_req, res) => {
  const clientId = getPaypalClientId();
  if (!clientId) return res.status(503).json({ error: 'PayPal ist nicht konfiguriert.' });
  return res.json({ clientId });
});

app.post('/api/paypal/create-order', requireChatCredentials, async (req, res) => {
  const { threadId } = req.body || {};
  if (!validThreadId(threadId)) {
    return res.status(400).json({ error: 'Ungültige Sitzung.' });
  }
  try {
    const payment = await getPayment(threadId);
    if (payment?.status !== 'pending') {
      logPayment('create_order_rejected', { threadId, status: payment?.status ?? null });
      return res.status(409).json({ error: 'Keine offene Zahlung.' });
    }
    const paypalOrderId = await createPaypalOrder(threadId, payment);
    logPayment('paypal_order_created', {
      threadId,
      paypalOrderId,
      amount: payment.amount,
      currency: payment.currency,
    });
    await updatePayment(threadId, (current) =>
      current?.status === 'pending' ? { ...current, paypalOrderId } : undefined
    );
    return res.json({ id: paypalOrderId });
  } catch (error) {
    console.error('[paypal] create error:', error);
    logPayment('paypal_order_create_failed', { threadId, error: error.message });
    return res.status(502).json({ error: 'Die Zahlung konnte nicht gestartet werden.' });
  }
});

app.post('/api/paypal/capture-order', requireChatCredentials, async (req, res) => {
  const { threadId, orderID } = req.body || {};
  if (!validThreadId(threadId) || typeof orderID !== 'string') {
    return res.status(400).json({ error: 'Ungültige Anfrage.' });
  }
  try {
    const payment = await getPayment(threadId);
    if (payment?.status === 'paid') return res.json({ ok: true });
    if (payment?.status !== 'pending' || payment.paypalOrderId !== orderID) {
      logPayment('capture_rejected', {
        threadId,
        paypalOrderId: orderID,
        status: payment?.status ?? null,
        expectedPaypalOrderId: payment?.paypalOrderId ?? null,
      });
      return res.status(409).json({ error: 'Keine passende offene Zahlung.' });
    }
    logPayment('capture_started', { threadId, paypalOrderId: orderID });
    const capture = await capturePaypalOrder(orderID);
    const amountMatches =
      Math.round(Number(capture.amount) * 100) === Math.round(payment.amount * 100) &&
      capture.currency === payment.currency;
    if (capture.status !== 'COMPLETED' || capture.captureStatus !== 'COMPLETED' || !amountMatches) {
      logPayment('capture_failed', {
        threadId,
        paypalOrderId: orderID,
        status: capture.status,
        captureStatus: capture.captureStatus,
        captured: `${capture.amount} ${capture.currency}`,
        expected: `${payment.amount} ${payment.currency}`,
      });
      await updatePayment(threadId, (current) => ({
        ...current,
        lastError: `Capture not completed (${capture.status}/${capture.captureStatus}, amount ${capture.amount} ${capture.currency})`,
        lastErrorAt: new Date().toISOString(),
      }));
      return res.status(402).json({ error: 'Die Zahlung wurde nicht abgeschlossen.' });
    }
    await updatePayment(threadId, (current) => ({
      ...current,
      status: 'paid',
      captureId: capture.captureId,
      payerEmail: capture.payerEmail,
      paidAt: new Date().toISOString(),
    }));
    logPayment('payment_captured', {
      threadId,
      paypalOrderId: orderID,
      captureId: capture.captureId,
      payerEmail: capture.payerEmail,
      amount: payment.amount,
      currency: payment.currency,
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('[paypal] capture error:', error);
    logPayment('capture_error', { threadId, paypalOrderId: orderID, error: error.message });
    await updatePayment(threadId, (current) =>
      current ? { ...current, lastError: error.message, lastErrorAt: new Date().toISOString() } : undefined
    ).catch(() => {});
    return res.status(502).json({ error: 'Die Zahlung konnte nicht bestätigt werden.' });
  }
});

app.get('/api/admin/orders-backup', requireAdminToken, (_req, res) => {
  if (!fs.existsSync(ordersBackupFilePath)) {
    return res.status(404).json({ error: 'Noch kein Backup vorhanden.' });
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="order.backup.json"');
  return res.sendFile(ordersBackupFilePath);
});

app.get('/api/payments', requireAdminToken, async (_req, res) => {
  try {
    const payments = await getAllPayments();
    const list = Object.entries(payments).map(([sessionId, record]) => ({
      sessionId,
      ...record,
      time: record.finalizedAt || record.paidAt || record.createdAt || null,
    }));
    return res.json(list);
  } catch (error) {
    console.error('[payments] read error:', error);
    return res.status(500).json({ error: 'Zahlungen konnten nicht geladen werden.' });
  }
});

app.get('/api/orders', requireAdminToken, async (_req, res) => {
  try {
    const [storedOrders, legacyOrders, payments] = await Promise.all([
      readOrderFile(ordersFilePath),
      readOrderFile(legacyOrdersFilePath),
      getAllPayments(),
    ]);
    const paymentsByPaypalId = new Map(
      Object.entries(payments)
        .filter(([, record]) => record?.paypalOrderId)
        .map(([sessionId, record]) => [
          record.paypalOrderId,
          {
            sessionId,
            recordStatus: record.status,
            amount: record.amount,
            currency: record.currency,
            paypalOrderId: record.paypalOrderId,
            captureId: record.captureId,
            payerEmail: record.payerEmail,
            paidAt: record.paidAt,
          },
        ])
    );
    const ordersById = new Map();
    for (const order of [...legacyOrders, ...storedOrders]) {
      if (order?.payment?.status !== 'COMPLETED') continue;
      const id = order?.time
        ? `${order.customerNumber}:${order.time}`
        : JSON.stringify(order);
      const record = paymentsByPaypalId.get(order.payment.paypalOrderId);
      ordersById.set(id, {
        ...order,
        payment: { ...record, ...order.payment, payerEmail: order.payment.payerEmail || record?.payerEmail },
      });
    }
    return res.json([...ordersById.values()]);
  } catch (error) {
    console.error('[orders] read error:', error);
    return res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden.' });
  }
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

app.get('/api/admin/customers', requireAdminToken, (_req, res) => {
  try {
    return res.json({ customers: getCustomerNumbers() });
  } catch (error) {
    console.error('[customers] read error:', error);
    return res.status(500).json({ error: 'Kundenliste konnte nicht geladen werden.' });
  }
});

app.put('/api/admin/customers', requireAdminToken, async (req, res) => {
  const { customers } = req.body || {};
  if (!Array.isArray(customers) || customers.length > 10000) {
    return res.status(400).json({ error: 'Ungültige Kundenliste.' });
  }
  try {
    return res.json({ customers: await saveCustomerNumbers(customers) });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: error.message });
    console.error('[customers] write error:', error);
    return res.status(500).json({ error: 'Kundenliste konnte nicht gespeichert werden.' });
  }
});

app.get('/api/menu', (_req, res) => {
  return res.json({ lunch: getMenuForPeriod('day'), dinner: getMenuForPeriod('evening') });
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

cron.schedule(
  '5 * * * *',
  () => backupOrders().catch((error) => console.error('[backup] failed:', error)),
  { timezone: process.env.BACKUP_TIMEZONE || 'Europe/Berlin' }
);

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
