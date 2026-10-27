/**
 * Remembers the customer number the server verified, for the current order only.
 *
 * The number lives in `sessionStorage`, so it survives a reload while the tab is open, but it is
 * gone once the order is finished or the tab is closed. Nothing here is a security boundary: the
 * server re-checks the number on every use and counts a rejected one as a failed attempt, so a
 * tampered value buys no advantage.
 */

const CUSTOMER_NUMBER_KEY = "ankerVerifiedCustomerV1";

/**
 * Reads the number remembered for this tab.
 *
 * `sessionStorage` can throw (Safari private mode, blocked storage), so every access is guarded and
 * a failure degrades to "not remembered" — the chat then simply asks for the number again.
 *
 * @returns {string} The stored number, or `""` when absent/unreadable. Capped at 40 characters to
 *   match what `saveCustomerNumber` would accept.
 */
export function loadCustomerNumber() {
  try {
    const stored = window.sessionStorage.getItem(CUSTOMER_NUMBER_KEY);
    return stored && stored.trim() ? stored.trim().slice(0, 40) : "";
  } catch {
    return "";
  }
}

/**
 * Stores a number the server just verified so the next reload can skip the check.
 *
 * Ignores blank input (nothing to remember) and truncates to 40 characters, matching the field the
 * admin maintains. A storage failure is swallowed on purpose: losing the convenience is harmless,
 * and the number is re-verified server-side anyway.
 *
 * @param {string} customerNumber Number taken from the `customerNumber` field of a chat reply.
 */
export function saveCustomerNumber(customerNumber) {
  const value = typeof customerNumber === "string" ? customerNumber.trim().slice(0, 40) : "";
  if (!value) return;
  try {
    window.sessionStorage.setItem(CUSTOMER_NUMBER_KEY, value);
  } catch {
    // A blocked or full storage only costs the convenience of skipping the check after a reload.
  }
}

/**
 * Forgets the remembered number.
 *
 * Called when the server reports the stored number as rejected, so the next reload asks again
 * instead of spending another failed attempt against the verification limit.
 */
export function clearCustomerNumber() {
  try {
    window.sessionStorage.removeItem(CUSTOMER_NUMBER_KEY);
  } catch {
    // Nothing to do: without storage there is nothing remembered anyway.
  }
}

/**
 * Ends the current order: forgets the verified customer number, so the next reload (or the next
 * order in this tab) starts fresh and asks for the number again.
 */
export function clearChatState() {
  clearCustomerNumber();
}
