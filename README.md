# @himetrica/replaykit

Session replay and friction signals for the web, by [Himetrica](https://himetrica.com).

ReplayKit records what happened on the page in the sessions that matter (an error, a rage click, a checkout, a paying customer) and flags friction in every session: rage clicks, dead clicks, JavaScript errors, back navigation and abandoned forms. Every recording belongs to the visitor and session the Himetrica tracker already knows, so you can go from a customer, a campaign or a revenue number straight to what they saw.

ReplayKit is a separate, optional SDK. It needs the Himetrica tracker on the same page.

## Install

```bash
npm install @himetrica/replaykit
```

```ts
import * as ReplayKit from "@himetrica/replaykit";

ReplayKit.init({ apiKey: "hm_..." }); // the same public key the tracker uses
```

Or with a script tag, after the tracker:

```html
<script src="https://unpkg.com/@himetrica/replaykit/dist/replaykit.global.js" data-api-key="hm_..."></script>
```

What gets recorded, and when, is configured per project in the dashboard (Settings → ReplayKit). The SDK reads it on every page, so changes apply without a deploy.

## When a session is recorded

By default ReplayKit does not record everything. It keeps the last ~30 seconds of the page in memory and only uploads a recording when one of these happens:

| Trigger | When |
| --- | --- |
| Error | A JavaScript error or unhandled promise rejection |
| Rage click | 3 or more clicks on the same spot within a second |
| Checkout | The visitor reaches a checkout path (configurable globs, e.g. `/checkout*`) |
| Paying customer | The visitor is a paying customer (decided by Himetrica) |
| Sample | A share of all sessions (5% by default) |
| Manual | You call `ReplayKit.start()` or `ReplayKit.trigger()` |

Because the last seconds are kept, the recording shows what led up to the trigger, including the previous page of the same session.

Signals are sent for every session (they are tiny and do not count against your recordings quota), even when recordings are turned off for the project.

## API

```ts
ReplayKit.init({ apiKey, apiUrl?, allowLocalhost?, debug? });

ReplayKit.start();            // record this session from now on
ReplayKit.trigger("refund");  // this moment matters: record it (reason is only logged with debug)
ReplayKit.stop();             // stop recording for the rest of the session
ReplayKit.consent(true);      // the visitor accepted your banner (see "Consent")
ReplayKit.getRecordingId();   // id of the recording running on this page, or null
ReplayKit.shutdown();         // remove every listener
```

## Privacy

These are on for every project and cannot be turned off:

- **Every input is masked.** Typed values are replaced by `*` before anything leaves the browser, passwords and card fields included.
- **Card fields and blocked elements never leave the page.** `input[type=password]`, `[autocomplete^="cc-"]`, `[data-hm-block]` and `.hm-block` are replaced by an empty box of the same size.
- **Query strings are never sent** with signals or page URLs.
- Canvas, cross-origin iframes and images inlined as data are not recorded.

You can go further:

- Mark any text with `class="hm-mask"` or `data-hm-mask` to mask it.
- Turn on "Mask all text" in the project to mask every text node.
- Add your own selectors to block, and paths never to record.

### Consent

With "Require consent" on in the project, nothing is recorded until your consent banner calls:

```ts
ReplayKit.consent(true);  // or false to stop and drop anything not uploaded yet
```

The answer is remembered on the device. `consent(false)` stops recording even when the project does not require consent.

## How it works

- Chunks of the recording are compressed in the browser (gzip) and uploaded straight to storage with a short-lived signed URL. They never pass through Himetrica's servers.
- Recordings are deleted after 30 days.
- rrweb is only downloaded on pages that may record; a page that only sends signals stays light.

## License

Apache-2.0
