"use client";
import { useEffect } from "react";
import { ensureDeviceToken } from "@/lib/deviceToken";
import { withBase } from "@/lib/basePath";

// Registers the service worker (offline capture + faster reloads).
//
// The install UI is deliberately GONE — no "Install GradeIQ" pill, no iOS
// add-to-home-screen hint. A consumer mid-trade-in should see the capture flow,
// not an app-store ask floating over the shutter button. The manifest is still
// linked, so anyone who wants to install can do it from the browser menu.
export default function PWARegister() {
  /* Mint the per-browser device token on EVERY page, before anything else runs.
   *
   * It lives here because this is the one component in the root layout: the
   * session can be started on /v2, the camera joins on /v2/cam, and the device
   * under test arrives via a QR link — three entry points, and a token minted
   * at only some of them would produce phantom "different browser" results on
   * the others. Setting the cookie is what lets the SERVER stamp provenance
   * without any call site remembering to attach it. */
  useEffect(() => {
    ensureDeviceToken();
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(withBase("/sw.js")).catch(() => {});
    }
  }, []);
  return null;
}
