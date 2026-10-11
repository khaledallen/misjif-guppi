# misjif-guppi

A GUPPI (Bobiverse-style) assistant that manages personal email and talks about priorities.

**Current phase: 1 — read-only ingest + triage.** GUPPI watches the inbox, classifies every new
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

Push to `main` → the workflow builds and deploys. (Or deploy once by hand: `firebase deploy`.)

### 6. Start it
```bash
API=https://us-central1-$PROJECT.cloudfunctions.net/api   # check the URL printed by deploy
TOKEN=<your GUPPI_API_TOKEN>

curl $API/health
curl -X POST -H "Authorization: Bearer $TOKEN" $API/watch
curl -X POST -H "Authorization: Bearer $TOKEN" "$API/backfill?n=200&days=30"
curl -H "Authorization: Bearer $TOKEN" $API/briefing
```

## Phase 1 exit criteria: grade the triage
1. Fill the `<placeholders>` in priorities (people, domains, projects) and upload:
   `curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" --data-binary @priorities.md $API/priorities`
2. Backfill 200 threads, pull `GET /triage?limit=200`, and mark where GUPPI is wrong.
3. Each wrong call shows `rule_applied` — fix the rule, re-run with `&force=1`.
4. When ≥90% of confident calls match your judgment, move to phase 2.

## API
| Route | Auth | |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /watch` | bearer | start/renew Gmail watch, set baseline historyId |
| `POST /backfill?n=&days=&force=1` | bearer | triage recent inbox threads |
| `GET /briefing` | bearer | GUPPI-format text briefing |
| `GET /triage?limit=` | bearer | raw triage records (JSON) |
| `GET/PUT /priorities` | bearer | read / replace the priorities markdown |

## Safety notes
- Email content is treated as untrusted data; threads that try to instruct GUPPI are flagged
  (`injection_suspected`) and surfaced in the briefing.
- Firestore rules deny all client access; only the functions (Admin SDK) touch data.
- Personal Gmail only.
