import { defineSecret, defineString } from "firebase-functions/params";

// Secrets live in Google Secret Manager. Set them once with:
//   firebase functions:secrets:set <NAME>
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
export const GMAIL_CLIENT_ID = defineSecret("GMAIL_CLIENT_ID");
export const GMAIL_CLIENT_SECRET = defineSecret("GMAIL_CLIENT_SECRET");
export const GMAIL_REFRESH_TOKEN = defineSecret("GMAIL_REFRESH_TOKEN");
// Bearer token that protects the HTTP API. Any long random string.
export const GUPPI_API_TOKEN = defineSecret("GUPPI_API_TOKEN");

export const GMAIL_SECRETS = [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN];
export const ALL_SECRETS = [ANTHROPIC_API_KEY, ...GMAIL_SECRETS, GUPPI_API_TOKEN];

// Non-secret config (overridable in functions/.env or at deploy time).
// Pub/Sub topic Gmail publishes to. Must exist before deploy (see README).
export const PUBSUB_TOPIC = "gmail-push";
export const TRIAGE_MODEL = defineString("GUPPI_TRIAGE_MODEL", { default: "claude-sonnet-5-5" });
export const TIMEZONE = "America/Denver";

// Triage calls below this confidence are never auto-handled.
export const CONFIDENCE_THRESHOLD = 0.6;
