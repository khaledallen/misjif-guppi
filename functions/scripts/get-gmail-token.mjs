#!/usr/bin/env node
// Run on YOUR laptop (not in CI) to mint a Gmail refresh token for GUPPI.
//
//   cd functions && npm install
//   npm run get-token -- <CLIENT_ID> <CLIENT_SECRET>
//
// The OAuth client must be of type "Desktop app". This opens a browser,
// you approve, and the refresh token prints to the terminal. Store it with:
//   firebase functions:secrets:set GMAIL_REFRESH_TOKEN
//
// Scope is gmail.readonly on purpose: phase 1 cannot change your mailbox.
import http from "node:http";
import { exec } from "node:child_process";
import { google } from "googleapis";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: npm run get-token -- <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  server.on("request", async (req, res) => {
    const code = new URL(req.url, redirectUri).searchParams.get("code");
    if (!code) {
      res.end("No code in request.");
      return;
    }
    try {
      const { tokens } = await oauth.getToken(code);
      res.end("[Acknowledged.] Token received. You can close this tab.");
      if (!tokens.refresh_token) {
        console.error("\nNo refresh_token returned. Revoke GUPPI at https://myaccount.google.com/permissions and retry.");
      } else {
        console.log("\nRefresh token (store it as GMAIL_REFRESH_TOKEN, do not commit it):\n");
        console.log(tokens.refresh_token);
      }
    } catch (err) {
      res.end("Token exchange failed; see terminal.");
      console.error(err);
    } finally {
      server.close();
    }
  });

  console.log("Opening browser for Google consent. If it doesn't open, visit:\n" + url);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${url}"`);
});
