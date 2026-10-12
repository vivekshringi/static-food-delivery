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

export function createBasicAuthorization({ username, password }) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}