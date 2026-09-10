# filmkritiken-backend

[![Build](https://github.com/DerBlum/filmkritiken-backend/actions/workflows/build_push.yml/badge.svg)](https://github.com/DerBlum/filmkritiken-backend/actions/workflows/build_push.yml)


## Setup
- Install gomock (```go install github.com/golang/mock/mockgen@v1.6.0```)

On a managed Windows machine without admin rights, where the endpoint protection blocks
freshly built binaries (`Access is denied` when running `go build` output, `mongod.exe`
unreadable), follow [docs/local-dev-windows-av.md](docs/local-dev-windows-av.md) instead
of the Docker flow.

## Persistence

`PERSISTENCE` selects the storage backend:

- `mongo` (default) – MongoDB, configured via `MONGODB_CONNECTION_URI` and `MONGODB_DATABASE`
- `memory` – in-memory store, seeded with the demo films from `infrastructure/db/seed`.
  For local development without a database; all data is lost when the process exits.

```bash
PERSISTENCE=memory make run
```

