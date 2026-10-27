/**
 * In-process event hub for the admin order screen.
 *
 * The ordering agent and the PayPal capture both run in this process, so a placed order can be
 * announced directly instead of the admin page polling the API. Clients connect over SSE
 * (`GET /api/admin/orders/stream`); every event is also kept in a small ring buffer so a client that
 * reconnects shortly after a drop can replay what it missed.
 *
 * Lifecycle: a publisher (`publishOrderEvent`, called from `finalizeOrder` in the agent) appends to
 * the ring buffer and writes an SSE frame to each registered response. The stream route registers a
 * response with `addOrderEventClient`, replays the gap with `eventsSince` / `eventsSinceTime`, and
 * unregisters on `close`.
 *
 * All state is module-level and in-memory: ids restart at 1 on every process start, and the buffer is
 * empty again. That matches the admin screen, which loads the full list from `GET /api/payments` on
 * mount and treats the stream as a trigger to reload, not as the source of truth.
 */

const MAX_HISTORY = 50;

/** @typedef {{ id: number, type: string, at: string, data: object }} OrderEvent */

/** Live SSE responses, one per connected admin tab. */
const clients = new Set();
/** Ring buffer of the most recent events, oldest first. @type {OrderEvent[]} */
const history = [];
/** Id of the most recent event; also the SSE `id:` field clients echo back as Last-Event-ID. */
let lastId = 0;

/**
 * Records an order event and pushes it to every connected admin client.
 *
 * Events are numbered monotonically so a reconnecting browser can ask for everything after the last
 * id it saw. Old entries are dropped from the ring buffer once it exceeds `MAX_HISTORY`; ids keep
 * increasing, so a replay request whose cursor points at an evicted event returns only what is still
 * buffered (nothing, once the cursor is behind the whole buffer). The admin page recovers from that
 * on the next live event, which makes it reload the full list through `GET /api/payments`.
 *
 * Writes to a response that has already gone away are swallowed by deleting that client, and the
 * event is still recorded, so one dead connection cannot block the others. Never throws for a
 * failed client write.
 *
 * @param {string} type Event name, for example "order.placed".
 * @param {object} data Payload for the client; must be JSON-serialisable and free of payment
 *   internals that the admin list does not need.
 * @returns {OrderEvent} The stored event, including its assigned id and timestamp.
 */
export function publishOrderEvent(type, data) {
  lastId += 1;
  const event = { id: lastId, type, at: new Date().toISOString(), data };
  history.push(event);
  if (history.length > MAX_HISTORY) history.shift();

  const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
  return event;
}

/**
 * Events after `lastEventId`, used when a client reconnects with Last-Event-ID.
 *
 * @param {number} lastEventId Highest event id the client has already processed.
 * @returns {OrderEvent[]} Events still in the ring buffer with a greater id, oldest first. Empty when
 *   the cursor is current or the gap has already been evicted.
 */
export function eventsSince(lastEventId) {
  return history.filter((event) => event.id > lastEventId);
}

/**
 * Events newer than the given ISO timestamp, used when a client reconnects without an id.
 *
 * This is the fallback path: `EventSource` only sends Last-Event-ID after it has received at least
 * one event, so a tab that connects, drops before the first push and retries can only say "since
 * when". An unparseable or missing timestamp yields no replay rather than every buffered event, so a
 * malformed query parameter cannot cause a burst.
 *
 * @param {string|undefined} sinceIso ISO-8601 timestamp, normally the `since` query parameter.
 * @returns {OrderEvent[]} Events with a timestamp strictly after `sinceIso`, oldest first. Empty when
 *   the timestamp is invalid.
 */
export function eventsSinceTime(sinceIso) {
  const since = Date.parse(String(sinceIso || ""));
  if (Number.isNaN(since)) return [];
  return history.filter((event) => Date.parse(event.at) > since);
}

/**
 * Registers an SSE response as a listener. Returns a function that removes it again.
 *
 * The caller owns the response (headers, replay, keep-alive frames) and must invoke the returned
 * remover on `close`, otherwise a dead response stays in the client set and every later
 * `publishOrderEvent` pays for it.
 *
 * @param {import('express').Response} res Response whose headers are already flushed as
 *   `text/event-stream`.
 * @returns {() => boolean} Removes the response from the client set; returns whether it was present.
 */
export function addOrderEventClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Number of currently connected admin listeners.
 *
 * Used for the `[orders-stream] connected/disconnected` log lines; a stuck or zero count is the
 * quickest signal that responses are not being unregistered.
 *
 * @returns {number} Size of the client set.
 */
export function orderEventClientCount() {
  return clients.size;
}
