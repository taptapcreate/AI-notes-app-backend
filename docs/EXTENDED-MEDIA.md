# Image batches and longer desktop audio

The desktop Image source accepts up to five images in one generated note. Pricing is based on the submitted attachment count: one image costs one credit, two or three cost two credits, and four or five cost three credits. This is available to Free and Pro users with sufficient credits; subscription allowances are unchanged.

Desktop audio accepts up to five minutes. Prepared 16 kHz mono PCM WAV recordings up to and including 180 seconds retain the existing `1 + audioExtra` price (two by default). Longer recordings through 300 seconds use `1 + audioLongExtra` (three by default). `generationMediaPricing.audioLongExtra` is optional in AppConfig and defaults to `audioExtra + 1`; it must exceed `audioExtra`. No database migration is required. Existing mobile compressed-audio pricing and PDF, video, screenshot, comparison and walkthrough pricing are unchanged.

Image batches retain `content` for the first image and add `additionalImages` for the next one to four, in order. Batches require `type: "image"`, `sourceKind: "image"`, `desktopMediaBilling: 1`, and the exact `mediaCreditQuote`. Their JPEG images must have a longest edge of at most 2,048 pixels and a combined decoded size of at most 15 MB. Desktop imports resize images locally without modifying the original files. Every selected image enters one provider request; none are silently omitted.

The backend determines credits from the actual attachment count and validated PCM data length, not client duration metadata. Invalid input or stale quotes fail before a reservation. Existing transactional reservations, result replay, insufficient-balance checks, cancellation and failure refunds also apply to three-credit requests.

Deploy this backend before distributing the corresponding desktop app. `/api/config` advertises `desktopExtendedMediaVersion: 1` and the normalized audio prices. Both renderer and main-process preflight block extended media against an older server. No pricing or limit change is activated in installed desktop apps until an updated app is distributed.

Validation uses local databases, fake provider responses, generated media fixtures and isolated Electron profiles. No production account, provider credit balance or media is used. Request limits do not guarantee a particular operating margin: provider prices, output length, free trials, refunds and infrastructure costs still affect it.
