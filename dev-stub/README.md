# dev-stub

Local stand-in for this backend, for machines where the endpoint protection (AV/EDR)
blocks the real thing:

- every freshly built `.exe` gets locked within seconds — `go build` succeeds, running
  the binary fails with `Access is denied`
- `mongod.exe` is blocked the same way, so no local MongoDB either

The stub serves the same HTTP contract as [`http/inbound/Server.go`](../http/inbound/Server.go)
from memory, seeded with the 13 films and posters from
[`infrastructure/db/seed/Seed.go`](../infrastructure/db/seed/Seed.go).

Full setup instructions: [`docs/local-dev-windows-av.md`](../docs/local-dev-windows-av.md).

## Run

From the repository root:

```bash
node dev-stub/server.js
```

Needs only Node (no `npm install`, no dependencies). Then start the frontend in the
`filmkritiken-frontend` checkout with `npm run dev`.

App: http://localhost:5173 — API: http://localhost:8080

Environment variables: `PORT` (default `8080`), `FRONTEND_URL` (default
`http://localhost:5173`, used for CORS and the login redirect).

## Covered endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | healthcheck |
| GET | `/api/filmkritiken` | `suche`/`titel`, `jahr`, `beitragvon`, `sortierung` (`neueste`/`aelteste`/`beste`), `limit` (default 10), `offset` |
| GET | `/api/filmkritiken/filter-options` | |
| GET | `/api/filmkritiken/:id` | 404 when unknown |
| GET | `/api/images/:imageId` | poster bytes |
| PUT | `/api/filmkritiken/:id/bewertungen/:username` | needs `bewertung.add` |
| PATCH | `/api/filmkritiken/:id/bewertungenoffen/:offen` | needs `bewertung.add` |
| POST | `/api/filme` | needs `film.add`, multipart `json` + `image` |
| GET | `/auth/login` | no Entra: logs you straight in and redirects to the frontend |
| GET | `/auth/me` | 401 without session |
| POST | `/auth/logout` | |

`/auth/login` grants `film.add` and `bewertung.add`, so the write flows are clickable.
Not covered: `/metrics`, real Entra OAuth.

## Differences from the real backend

- data is in memory and lost on restart
- no MongoDB semantics (no indexes, no TTL cleanup of sessions)
- session cookie is not signed, no JWT validation
- the seed data is duplicated in `films.js`; if `Seed.go` changes, this copy does not
  follow automatically

Once the Go backend can run locally, use `PERSISTENCE=memory` (see
[`cmd/backend/main.go`](../cmd/backend/main.go)) instead of this stub.
