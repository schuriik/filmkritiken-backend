# Local setup on a managed Windows machine (no admin, AV blocks binaries)

This is the setup path for a corporate Windows laptop where

- you have **no admin rights** (no Docker Desktop, no MSI installers, no WSL), and
- the endpoint protection (Defender ASR / EDR) **blocks freshly built `.exe` files**.

The documented setup (`make run-docker`) does not work there. Follow this instead.
You end up with the real Vue frontend running against a Node stub API, plus a Go
toolchain that compiles and vets the backend code.

Verified on Windows 11 Enterprise 26100, Git Bash, September 2026.

---

## 0. Check whether you are actually affected

Run the two checks below before installing anything — if both pass, you do not need
this document, use the normal `make run-docker` flow.

```bash
where.exe docker go
```

If both are missing, you have no toolchain yet. Continue with step 1, then come back
to the AV check in step 3.

---

## 1. Install Go without admin rights

The Go ZIP needs no installer and no admin rights.

```bash
mkdir -p ~/tools/dl && cd ~/tools/dl
curl -sL -o go.zip https://go.dev/dl/go1.27.1.windows-amd64.zip
```

Verify the download against the checksum published on <https://go.dev/dl/>
(`go1.27.1.windows-amd64.zip`, expected
`a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d`):

```bash
sha256sum go.zip
```

Extract with the Windows `tar` (bsdtar — it reads ZIP; the Git Bash `tar` does not):

```bash
cd ~/tools && /c/Windows/System32/tar.exe -xf dl/go.zip && ./go/bin/go.exe version
```

Add this to your `~/.bashrc`. `GOPATH` **must be a Windows-style path** — Go rejects
the `/c/...` form as relative:

```bash
export PATH="$HOME/tools/go/bin:$PATH"
export GOPATH='C:\Users\<you>\go'
export GOTMPDIR='C:\Users\<you>\tools\gotmp'
```

```bash
mkdir -p ~/tools/gotmp && source ~/.bashrc && go version
```

`GOTMPDIR` moves Go's scratch directory out of `%TEMP%`. On some configurations that
alone is enough to get test binaries running — on the machine this was written for it
was not, see step 3.

## 2. Confirm the backend compiles

From the `filmkritiken-backend` checkout:

```bash
go build ./... && go vet ./...
```

Both must be silent. Compiling is not blocked by the AV — only *running* the result is.

## 3. Confirm the AV blocker (and stop guessing)

```bash
go build -o bin/backend.exe ./cmd/backend && ./bin/backend.exe
```

If you see `Permission denied` / `Zugriff verweigert`, you are affected. Confirm it is
the AV and not a file-permission problem:

```bash
head -c 2 bin/backend.exe        # "Permission denied" => the file is locked, not just non-executable
/c/Windows/System32/icacls.exe "$(cygpath -w bin/backend.exe)"
```

`icacls` showing your account with `(F)` (full control) while `head` still cannot read
one single byte means the endpoint protection has locked the file. Same for MongoDB:
`mongod.exe` is unreadable while every other file in its `bin/` folder reads fine.

**Do not try to work around the AV.** Delete the test binary and move on:

```bash
rm -rf bin
```

Also expect `go test ./...` to fail for the same reason:

```
fork/exec ...\filmkritiken.test.exe: Access is denied.
FAIL	github.com/DerBlum/filmkritiken-backend/domain/filmkritiken
```

**Consequence: you cannot run the Go test suite locally.** Rely on `go build`,
`go vet`, and the CI pipeline for the backend, and review backend changes accordingly.

## 4. Run the stub API instead of the backend

[`dev-stub/`](../dev-stub) serves the same HTTP contract from memory, seeded with the
same 13 films and posters as `infrastructure/db/seed`. Node is signed and prevalent, so
the AV allows it.

From the repository root:

```bash
node dev-stub/server.js
```

Expected output:

```
seeded 13 filmkritiken, 13 posters
dev stub listening on http://localhost:8080 (CORS for http://localhost:5173)
```

Leave it running. See [`dev-stub/README.md`](../dev-stub/README.md) for the endpoint
list and the known differences from the real backend.

## 5. Run the frontend

In the `filmkritiken-frontend` checkout, next to this one:

```bash
npm install
```

Create `.env` (git-ignored, `.env.example` has the same content):

```
VITE_API_URL=http://localhost:8080
```

```bash
npm run dev
```

Open <http://localhost:5173>.

## 6. Verify

- home page shows "Letzte Besprechung" with a poster (A Quiet Place)
- Archiv lists 13 films, search for `alien` returns 2 hits
- clicking **Login** logs you straight in — the stub skips Entra and grants `film.add`
  and `bewertung.add`, so rating and film creation are clickable
- the nav switches from Login to Logout

Quick API check without the browser:

```bash
curl -s "http://localhost:8080/api/filmkritiken?limit=2" | head -c 200
```

---

## What is *not* covered

| | Status |
| --- | --- |
| Frontend, all views and flows | works |
| Backend compile, `go vet`, static analysis | works |
| Backend `go test ./...` | **blocked** by the AV |
| Running the real Go backend | **blocked** by the AV |
| Local MongoDB, `mongo-express`, `make seed` | **blocked** (`mongod.exe` locked) |
| Real Entra ID login, `/metrics` | not implemented in the stub |

## Getting the real stack (needs IT)

Ask IT for a Defender/EDR exclusion for your dev folder (e.g. `%USERPROFILE%\workspace`)
plus the Go build cache, and for `mongod.exe`. Mention the specific symptom — newly
written PE files being locked within seconds — since that points at the ASR rule
"Block executable files from running unless they meet a prevalence, age, or trusted
list criterion" rather than at a signature hit.

Once binaries can run, you no longer need the stub:

```bash
PERSISTENCE=memory make run     # real backend, in-memory store, no MongoDB needed
```

And with MongoDB allowed as well, the documented flow works:

```bash
make run-docker                 # needs Docker, i.e. admin rights
```

Alternatively install MongoDB from the ZIP the same way as Go
(<https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.3.9.zip>, checksum from
<https://downloads.mongodb.org/current.json>) and run it standalone — the code uses no
transactions or change streams, so a replica set is not required:

```bash
mkdir -p ~/tools/mongodb-data
~/tools/mongodb-win32-x86_64-windows-8.3.9/bin/mongod.exe \
  --dbpath "$(cygpath -w ~/tools/mongodb-data)" --bind_ip 127.0.0.1 --port 27017
```

Then `make seed` and `make run` with `config/local.env`.
