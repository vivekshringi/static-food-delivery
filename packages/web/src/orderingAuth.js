/**
 * Chat credentials, taken from the link and kept for the tab's lifetime.
 *
 * The ordering endpoints require HTTP Basic auth, but a phone cannot be expected to type a browser
 * login prompt, so the admin hands out a link like `/ordernow?user=…&password=…`. These helpers read
 * that link once, scrub it from the address bar and history, and stash the pair in `sessionStorage`
 * so a reload keeps working without the secret reappearing in the URL.
 */

/**
 * Reads `user`/`username` and `password` from the current URL and removes them from it.
 *
 * Scrubbing happens even when only one of the two is present, so a half-typed or partially shared
 * link does not leave the username in the address bar. `replaceState` (not `pushState`) avoids
 * leaving the credentialed URL as a back-button target.
 *
 * @returns {{ username: string, password: string } | null} The credentials, or `null` when the URL
 *   carries no usable pair.
 */
export function takeUrlCredentials() {
  const url = new URL(window.location.href);
  const username = url.searchParams.get("user") || url.searchParams.get("username");
  const password = url.searchParams.get("password");
  const hadCredentials =
    url.searchParams.has("user") ||
    url.searchParams.has("username") ||
    url.searchParams.has("password");

  if (hadCredentials) {
    url.searchParams.delete("user");
    url.searchParams.delete("username");
    url.searchParams.delete("password");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }

  return username && password ? { username, password } : null;
}

// Keeps the chat credentials for this tab only, so a reload can continue the chat: the URL no
// longer carries them after the first page view, and a new tab still needs the link.
const CREDENTIALS_KEY = "ankerChatCredentialsV1";

/**
 * Stores the credentials for this tab so a reload does not need the link again.
 *
 * Deliberately `sessionStorage`: a new tab or a closed browser needs the link, which keeps the
 * shared chat password from persisting on the device. Ignores incomplete input, and a storage
 * failure only costs a re-open from the link.
 *
 * @param {{ username: string, password: string } | null} credentials
 */
export function rememberCredentials(credentials) {
  if (!credentials?.username || !credentials?.password) return;
  try {
    sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  } catch {
    // Without storage the chat still works, only a reload needs the link again.
  }
}

/**
 * Reads back what `rememberCredentials` stored.
 *
 * @returns {{ username: string, password: string } | null} The remembered pair, or `null` when
 *   nothing valid is stored (missing entry, blocked storage, or malformed JSON).
 */
export function loadRememberedCredentials() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CREDENTIALS_KEY));
    return parsed?.username && parsed?.password ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Builds the `Authorization` header value for the chat and PayPal endpoints.
 *
 * Encodes UTF-8 by hand before `btoa`, because `btoa` only accepts Latin-1 and would throw on a
 * password containing accented characters or an emoji.
 *
 * @param {{ username: string, password: string }} credentials
 * @returns {string} `Basic <base64 of "username:password">`.
 */
export function createBasicAuthorization({ username, password }) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}