# Stack

Everything OpenReply needs to run, in one place: the application libraries, the
runtime processes, and the specific (free) services this instance is deployed on.
For the step-by-step setup, see [setup.md](setup.md).

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Queue | BullMQ 5 on Redis, via `ioredis` |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | Resend (login links) |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Worker runtime | `tsx` (runs `worker/dm-worker.ts`) |
| Instagram | Official Meta Graph API (Instagram Login) |

## Runtime — two processes, two datastores

- **Web app + API** (`npm run dev` / `npm start`): Next.js. Serves the dashboard,
  the OAuth callback, and the incoming webhook. Serverless-friendly; runs on Vercel.
- **Worker** (`npm run worker`): a long-running Node process. Consumes the send
  queue, sends the DMs, runs the polling reconciler, and performs the follow-gate
  `is_user_follow_business` checks. **Must stay always-on**, so it cannot run on
  Vercel — it needs an always-on host.
- **PostgreSQL**: campaigns, DM logs, accounts, sessions, tracked links, click events.
- **Redis**: the BullMQ send queue and the per-account rate limiter. Must speak the
  native Redis protocol over TCP (an HTTP-only Redis will not work with BullMQ).

The web app and the worker must share the same `DATABASE_URL`, `REDIS_URL`, and
`ENCRYPTION_KEY`. The web app stores the encrypted Instagram token; the worker
decrypts it to send. Different keys mean every send fails to decrypt.

## Reference free deployment

The zero-cost stack this instance runs on: one Oracle Cloud "Always Free" VM
(VM.Standard.E2.1.Micro, 1 GB, Ubuntu) running all four processes, with systemd
keeping them up. Alternatives — Vercel for the web app, Railway or Neon for the
datastores — are covered in [setup.md](setup.md).

| Piece | Service | Free tier |
| --- | --- | --- |
| Web app, worker, PostgreSQL, Redis | Oracle Cloud "Always Free" VM | Free forever |
| TLS + reverse proxy | Caddy on the same box (Let's Encrypt) | Free |
| Login email | Resend | Free (3k emails/mo) |
| Instagram API | Meta app with Instagram Login | Free |

Two consequences of the single box worth knowing:

- **The web app is built in CI, not on the box.** 1 GB is not enough for
  `next build`. `.github/workflows/release.yml` publishes a Next.js standalone
  bundle as a release asset and `deploy/pull-release.sh` installs it.
- **Memory is the binding constraint.** Measured on the box: the OS plus the
  worker already occupy ~411M of 956M usable. Postgres (~90M), Redis (~25M), the
  web app (~150M) and Caddy (~20M) bring it to roughly 700M, with a 2 GB
  swapfile as the cushion. The heap caps in the systemd units and the Postgres
  tuning in `deploy/oracle-box-setup.sh` are what keep that budget honest, and
  `journalctl -k | grep -i oom` is the first place to look if something dies.

## Environment variables

Names only — values live in `.env` (gitignored) or the host's env settings, never
in the repo. Full descriptions are in [setup.md](setup.md#environment-variables).

`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `META_GRAPH_API_VERSION`,
`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`,
`WEBHOOK_VERIFY_TOKEN`.
