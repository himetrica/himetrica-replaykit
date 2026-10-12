// Script-tag build: dist/replaykit.global.js.
//
//   <script src="https://cdn.../replaykit.global.js" data-api-key="hm_..."></script>
//
// Exposes window.ReplayKit (same API as the npm entry) and initializes itself from
// the data attributes of its own <script> tag. Without data-api-key it only exposes
// the API, so the page can call ReplayKit.init({...}) itself. Load it after the
// Himetrica tracker.

import * as ReplayKit from "./index";

declare global {
  interface Window {
    ReplayKit?: typeof ReplayKit;
  }
}

if (typeof window !== "undefined") {
  window.ReplayKit = ReplayKit;
  const script = document.currentScript as HTMLScriptElement | null;
  const data = script?.dataset;
  if (data?.apiKey) {
    ReplayKit.init({
      apiKey: data.apiKey,
      apiUrl: data.apiUrl || undefined,
      allowLocalhost: data.allowLocalhost === "true",
      debug: data.debug === "true",
    });
  }
}
