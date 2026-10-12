# misjif-guppi

A GUPPI (Bobiverse-style) assistant that manages personal email and talks about priorities.

**Current phase: 1 — read-only ingest + triage (live: watch, push triage and briefings verified 2026-10-11).** GUPPI watches the inbox, classifies every new
thread against `priorities` (a living markdown doc), and produces briefings. It holds a
`gmail.readonly` token, so it *cannot* change, archive or send anything yet.

```
Gmail ──watch──▶ Pub/Sub (gmail-push) ──▶ gmailPush fn ──▶ Claude triage ──▶ Firestore
                                                                   ▲               │
                                              priorities doc ──────┘               ▼
                                                                         api fn: /briefing, /triage
```

| Piece | Where |
|---|---|
| Gmail fetch, watch, history sync | `functions/src/gmail.ts` |
| Triage prompt + JSON tool schema | `functions/src/triage.ts` |
| Batch pipeline (idempotent per message) | `functions/src/pipeline.ts` |
| Briefing formatter | `functions/src/briefing.ts` |
| Functions: `gmailPush`, `renewWatch`, `api` | `functions/src/index.ts` |
| Default priorities (seeded on first run) | `functions/prompts/priorities.default.md` |
| CLI client (`guppi`) | `cli/guppi.mjs` |
| Prompt design notes | `docs/prompt-design.md` |

## Roadmap
1. **Core: ingest + read-only triage** ← you are here
2. Telegram: text + voice notes, conversation loop that edits priorities
3. Web app: push-to-talk + dashboard
4. Email briefings
5. Phone calls (Twilio, realtime voice)

Mailbox actions (label/archive, then drafts with explicit send approval) switch on only after
read-only triage has been graded and trusted.

---

## One-time setup (≈30 min)

You need: the `gcloud` and `firebase` CLIs, Node 22, and a Google Cloud / Firebase project
(Blaze plan — Cloud Functions 2nd gen and Secret Manager require it).

```bash
export PROJECT=<your-firebase-project-id>
gcloud config set project $PROJECT
```

### 1. Enable APIs
```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com run.googleapis.com eventarc.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
```
Create a Firestore database (Native mode) in the console if the project doesn't have one.

### 2. Pub/Sub topic Gmail can publish to
```bash
gcloud pubsub topics create gmail-push
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

### 3. OAuth client + refresh token
1. Console → APIs & Services → **OAuth consent screen**: External, add yourself as a user,
   add scope `.../auth/gmail.readonly`.
2. Set publishing status to **In production**. (In "Testing", refresh tokens die after 7 days.
   You'll see an "unverified app" warning when you consent — that's expected for a
   single-user personal app; click through.)
3. **Credentials → Create OAuth client ID → Desktop app.** Note the client ID and secret.
4. Mint the token on your laptop:
   ```bash
   cd functions && npm install
   npm run get-token -- <CLIENT_ID> <CLIENT_SECRET>
   ```

### 4. Secrets (Secret Manager)
The name goes on the command line exactly as written (UPPER_SNAKE_CASE); the CLI then prompts for
the value. List what exists with `gcloud secrets list`.
```bash
firebase use $PROJECT
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set GMAIL_CLIENT_ID
firebase functions:secrets:set GMAIL_CLIENT_SECRET
firebase functions:secrets:set GMAIL_REFRESH_TOKEN
firebase functions:secrets:set GUPPI_API_TOKEN     # paste output of: openssl rand -hex 32
```

### 5. GitHub Actions deploy credentials
Create a deploy service account:
```bash
gcloud iam service-accounts create guppi-deployer
SA=guppi-deployer@$PROJECT.iam.gserviceaccount.com
for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin \
  roles/iam.serviceAccountUser roles/secretmanager.viewer roles/cloudscheduler.admin \
  roles/eventarc.admin roles/pubsub.admin roles/artifactregistry.admin \
  roles/serviceusage.serviceUsageConsumer roles/datastore.indexAdmin; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=$role --condition=None
done
gcloud iam service-accounts keys create key.json --iam-account=$SA
```
In the GitHub repo → Settings → Secrets and variables → Actions:
- **Secret** `FIREBASE_SERVICE_ACCOUNT` = contents of `key.json` (then delete the local file)
- **Variable** `FIREBASE_PROJECT_ID` = your project id

Use **repo** secrets/variables, not environment ones. If `key.json` comes out empty, the service
account didn't exist yet when the key command ran — confirm with `gcloud iam service-accounts list`
and rerun it.

Push to `main` → the workflow builds and deploys. (Or deploy once by hand: `firebase deploy`.)

### 6. Start it
If authenticated calls return 401 with a Google error page (not `[Unauthorized.]`), the deploy
didn't make the function publicly invokable. Fix it once — the bearer token still guards every route:
```bash
gcloud run services add-iam-policy-binding api --region=us-central1 --project=$PROJECT \
  --member=allUsers --role=roles/run.invoker
```
Then install the CLI and start GUPPI:
```bash
npm install -g ./cli      # from the repo root; puts `guppi` on your PATH
guppi init --project $PROJECT
guppi watch
guppi backfill --n 50 --days 7
guppi briefing
```

## CLI
`guppi` finds the API URL and token itself; no `TOKEN`/`API` variables needed.

- **Config:** `~/.config/guppi/config.json` (project, region, API URL), written by `guppi init`.
- **Token:** fetched from Secret Manager with your `gcloud` login, then cached in the macOS
  Keychain (service `guppi-api-token`), or `~/.config/guppi/token-<project>` (mode 600) on other
  systems. Never printed or written to shell history. If the cached token is rejected, the CLI
  refetches it once automatically, so rotating `GUPPI_API_TOKEN` (and redeploying) needs no CLI step.

```bash
guppi briefing                                # the briefing
guppi triage                                  # open calls (still in the inbox), sorted by priority
guppi triage --all                            # include archived/handled threads (grading)
guppi sync                                    # re-check what's still in the inbox (also automatic)
guppi triage --judgment                       # only calls no rule covered: what to write rules for
guppi triage --wide | --json | --limit 200
guppi backfill --n 50 --days 7 [--force]      # --force re-triages after a priorities change
guppi priorities edit                         # opens $EDITOR, shows a diff, uploads on save
guppi priorities get > priorities.md
guppi priorities put priorities.md
guppi chat                                    # talk to GUPPI (/new /continue /briefing /quit)
guppi chat -m "what needs my attention?"      # one-shot
guppi priorities history                      # every change is versioned
guppi priorities restore <id>
guppi watch | guppi health
guppi token refresh | guppi token clear
```

Overrides for scripting: `GUPPI_API`, `GUPPI_TOKEN`, `GUPPI_PROJECT`. Tests: `cd cli && npm test`.

Raw curl still works if you need it:
`curl -H "Authorization: Bearer $(gcloud secrets versions access latest --secret=GUPPI_API_TOKEN)" <api-url>/briefing`

## Phase 1 exit criteria: grade the triage
1. Fill the `<placeholders>` in priorities (people by email/domain, projects): `guppi priorities edit`
2. `guppi backfill --n 200 --days 30`, then `guppi triage --limit 200` and mark where GUPPI is wrong.
3. Each wrong call shows its rule — fix the rule, then `guppi backfill --n 200 --days 30 --force`.
   `guppi triage --judgment` lists the calls no rule covered.
4. When ≥90% of confident calls match your judgment, move to phase 2.

## API
| Route | Auth | |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /watch` | bearer | start/renew Gmail watch, set baseline historyId |
| `POST /backfill?n=&days=&force=1` | bearer | triage recent inbox threads |
| `GET /briefing` | bearer | GUPPI-format text briefing |
| `GET /triage?limit=&status=` | bearer | triage records (JSON); `status=open\|done\|dismissed\|all` (default all) |
| `POST /sync` | bearer | close items whose threads left the inbox; reopen ones that came back |
| `GET/PUT /priorities` | bearer | read / replace the priorities markdown (previous version saved) |
| `GET /priorities/history` | bearer | previous versions (`?full=1` includes markdown) |
| `POST /priorities/restore?id=` | bearer | roll back to a previous version |
| `POST /chat` | bearer | `{message, session: auto\|new\|continue, channel}` → GUPPI reply, proposals, applied changes |
| `GET /chat/session` | bearer | current session info |

## Chat (`guppi chat`)
GUPPI answers from your triage queue and can change the priorities doc conversationally.

- **Sessions:** a new session starts after 4 hours idle; `/continue` resumes the previous one, `/new` starts
  fresh. Each session starts with the current briefing loaded. Durable learning lives in the priorities doc
  (and, later, explicit memory, #8), not in the conversation.
- **Priority changes:** GUPPI proposes a full new version; you see a **server-generated diff** (never the
  model's paraphrase) and reply `yes` to apply. Saying "always"/"from now on" applies in the same turn. The
  check is done by the server on your own words, so the model can't apply a change you didn't confirm.
  Every change is versioned (`guppi priorities history` / `restore`), logged in the Corrections log, and
  followed by an automatic re-triage of open threads that reports what moved.
- **Reading email:** the chat model never sees raw email text. Questions needing the full text go to a
  **quarantined reader**, a separate model call with no tools, and only its answer comes back. Injected
  instructions in an email can't reach the chat's tools.

## Checks
CI runs these on every PR, and deploys only if they pass:
- `cd functions && npm test`: TypeScript build (strict) + backend unit tests
- `cd cli && npm test`: CLI unit tests
- `npm run lint` and `npm run format:check` (from the repo root, after `npm install` there and in
  `functions/`): ESLint with type-aware rules, and Prettier. `npm run format` fixes formatting.

## Safety notes
- **Fail visible:** a thread that can't be triaged (API error, output cut off) is recorded as a
  zero-confidence `triage_failed` item under "Needs your call" and retried on the next backfill.
  It never silently disappears.
- **Inbox sync:** briefings and `/triage` reconcile with the live inbox, so archived or deleted
  threads drop out of the open queue.
- Email content is treated as untrusted data; threads that try to instruct GUPPI are flagged
  (`injection_suspected`) and surfaced in the briefing.
- Firestore rules deny all client access; only the functions (Admin SDK) touch data.
- Personal Gmail only.
