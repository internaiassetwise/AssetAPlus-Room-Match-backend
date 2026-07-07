# 🏠 Room Match — Backend

Express + PostgreSQL API for the Asset A Plus rental matching platform.

- **Stack** — Node 20, Express 4, pg (raw SQL + repository pattern)
- **Auth** — bcryptjs + HTTP-only session cookies (`admin_sessions` table)
- **Validation** — zod schemas at route boundaries
- **Deploy** — Render Blueprint (`render.yaml`) or Docker (`Dockerfile`)

---

## 🚀 Quick Start

> Requires **Node.js ≥ 18** (`.nvmrc` pins 20) and a running PostgreSQL.

```bash
# 1. Install
npm install

# 2. Start PostgreSQL — pick ONE:
#    a) Docker (zero install):
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/room_match

#    b) Homebrew Postgres:
# brew services start postgresql@15
# export DATABASE_URL=postgres://$(whoami)@localhost:5432/room_match

#    c) Supabase / Render Postgres: copy the connection string from their UI

# 3. Configure env
cp .env.example .env
# edit .env → DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD

# 4. Apply schema + seed
npm run db:reset

# 5. Start the API (http://localhost:4000)
npm run dev
```

Then check it:

```bash
curl http://localhost:4000/api/health
```

---

## 📁 Project Structure

```
.
├── src/
│   ├── server.js          # boot, signals
│   ├── app.js             # Express factory
│   ├── config.js          # zod env validation
│   ├── logger.js          # pino
│   ├── db/
│   │   ├── pool.js        # pg.Pool + helpers
│   │   ├── init.js        # schema + seed
│   │   ├── schema.sql
│   │   ├── seed.sql
│   │   └── repositories/  # rooms, zones, reviews, stats, preferences, landlords, admins
│   ├── middleware/        # error, validate, logger, notFound, requireAdmin
│   └── routes/            # health, rooms, zones, reviews, stats, preferences, contact, auth
├── Dockerfile             # multi-stage production image
├── docker-compose.yml     # local Postgres for dev
└── render.yaml            # Render Blueprint
```

---

## 🔌 API

Base URL: `http://localhost:4000/api` (or `/api/v1` for the versioned routes).

| Method | Endpoint              | Description                                              |
|--------|-----------------------|----------------------------------------------------------|
| GET    | `/health`             | Service health check (also pings DB)                     |
| GET    | `/rooms`              | List available rooms. Query: `?zone=thon&maxRent=20000`  |
| GET    | `/rooms/:id`          | Room detail (also bumps view counter)                    |
| GET    | `/zones`              | Active zones with available-room count                   |
| GET    | `/reviews`            | Featured reviews                                         |
| GET    | `/stats`              | Aggregate stats (rooms total, avg rating, matches)       |
| POST   | `/preferences`        | "ฝากห้อง" form → creates landlord + preference           |
| POST   | `/contact`            | Quick contact form                                       |
| POST   | `/auth/login`         | Admin login (sets `admin_session` cookie)                |
| POST   | `/auth/logout`        | Admin logout                                             |
| GET    | `/auth/me`            | Who am I (admin)                                         |
| POST   | `/rooms`              | Create room (admin)                                      |
| PATCH  | `/rooms/:id`          | Partial update (admin)                                   |
| DELETE | `/rooms/:id`          | Remove (admin)                                           |

Public read endpoints stay anonymous; only write/admin endpoints require the cookie.

---

## 🔐 Admin Bootstrap

The first time the server boots (or whenever the `admins` table is empty) one admin
row is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Changing the password
later and restarting will upsert the hash.

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin1234
```

**Sessions** — bcrypt-hashed password + 64-char hex token, stored in
`admin_sessions`. Sent to the browser as an `admin_session` HTTP-only cookie with
`SameSite=Lax` and 7-day expiry.

---

## 🚢 Deploy

The repo ships with manifests for two deployment paths:

| Target         | Manifest       | Notes                                     |
|----------------|----------------|-------------------------------------------|
| **Render**     | `render.yaml`  | Blueprint — provisions API + Postgres     |
| **Docker**     | `Dockerfile`   | Multi-stage image; bring your own DB      |

After deploy, point the frontend's `VITE_API_BASE` at the public API URL.

---

## 📝 Useful Commands

```bash
npm run dev           # node --watch src/server.js
npm run start         # production: node src/server.js
npm run db:init       # apply schema + seed (idempotent)
npm run db:reset      # drop public schema, recreate, reseed
```

---

## 📞 Contact

- ☎️ **02-168-0000**
- 💬 **LINE @assetaplus**

Built for Asset Wise — let us take care of your room. 🏠