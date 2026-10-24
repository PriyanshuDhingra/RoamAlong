import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DemoShell } from "./components/DemoShell.js";

// Desktop browsers get the showcase page with the app in a phone frame; phones, the iOS shell and the
// framed app itself (?app=1) get the app full screen.
const params = new URLSearchParams(window.location.search);
const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const inNativeShell = "ReactNativeWebView" in window;
const showDemo =
  !isPhone && !inNativeShell && window.parent === window && !params.has("app");

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>{showDemo ? <DemoShell /> : <App />}</React.StrictMode>
  );
}
