/**
 * SPA entry point: mounts `App` inside React StrictMode and the router.
 *
 * StrictMode intentionally runs effects twice in development, which is why the chat page guards its
 * opening request with a ref — production builds are unaffected.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
