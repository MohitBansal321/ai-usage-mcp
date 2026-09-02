# Publishing to npm

Everything in this repo is ready to publish as **`ai-usage-mcp`** (name confirmed available on
the public registry). The only step that cannot be automated is `npm login`, which is
interactive.

Once published, anyone gets it with:

```bash
claude mcp add ai-usage -- npx -y ai-usage-mcp     # no install at all
# or
npm install -g ai-usage-mcp && claude mcp add ai-usage -- ai-usage-mcp
```

---

## One-time setup

1. Create an account at <https://www.npmjs.com/signup> (skip if you have one).
2. Log in from this machine:

```bash
npm login              # opens a browser; asks for your 2FA code if enabled
npm whoami             # must print your username
```

3. Optional but recommended — add repository metadata so the npm page links back to your
   source. Run this once you have a GitHub repo, substituting your URL:

```bash
npm pkg set \
  repository.type="git" \
  repository.url="git+https://github.com/<you>/ai-usage-mcp.git" \
  bugs.url="https://github.com/<you>/ai-usage-mcp/issues" \
  homepage="https://github.com/<you>/ai-usage-mcp#readme" \
  author="<your name>"
```

Publishing works without these; they only affect the package page.

---

## Pre-flight

```bash
npm whoami                    # logged in?
npm view ai-usage-mcp version # "404 Not Found" means the name is still yours to take
npm pack --dry-run            # review exactly what will ship
```

`npm pack --dry-run` should list `dist/`, `docs/`, `README.md`, `LICENSE`, `package.json` —
about 75 kB, 100 files. It must **not** contain `src/`, `tests/`, `node_modules/`, or any
`.db` file. That is enforced by the `files` array in `package.json`.

A `prepublishOnly` hook runs `npm run build && npm test` automatically, so a publish cannot
succeed with a failing build or a failing test.

---

## Publish

```bash
npm publish
```

Unscoped packages are public by default. That single command runs the build, runs all 63
tests, then uploads.

If you ever switch to a scoped name (`@your-org/ai-usage-mcp`), the first publish needs
`npm publish --access public`, or it goes out private and nobody can install it.

---

## Verify it actually works for a stranger

```bash
npm view ai-usage-mcp                       # appears on the registry

# install exactly as a new user would, into a throwaway prefix
npm install -g --prefix /tmp/verify ai-usage-mcp
/tmp/verify/bin/ai-usage --version
/tmp/verify/bin/ai-usage status

# and the zero-install path
npx -y -p ai-usage-mcp ai-usage --version
```

Then register it and confirm the MCP handshake:

```bash
claude mcp add ai-usage -- npx -y ai-usage-mcp
claude mcp list
# then run /mcp inside Claude Code
```

---

## Later releases

```bash
npm version patch        # or minor / major -- commits and tags if this is a git repo
npm publish
```

The version the MCP server advertises is read from `package.json` at runtime, so there is no
constant in `src/` to keep in sync. `server.json` **is** a second place the version lives —
see [Version agreement](#version-agreement) below.

---

## Publishing to the MCP registry

The official MCP registry (`registry.modelcontextprotocol.io`) is what feeds PulseMCP, Glama,
mcp.so and the other directories. Two files drive it:

- `package.json` → `"mcpName": "io.github.MohitBansal321/ai-usage-mcp"`
- `server.json` at the repo root — the registry entry itself.

The `registry` job in `.github/workflows/release.yml` does the publish on a `v*` tag, using
`mcp-publisher login github-oidc`. There is no secret: the OIDC token is exchanged for a
registry JWT granting `io.github.<repository_owner>/*`, which is why the job needs
`id-token: write`.

### Ordering constraint: npm first, always

**The registry verifies package ownership by downloading the published npm tarball and
reading `mcpName` out of the `package.json` inside it.** It does not read this repository. So:

1. A **new npm version must be published first**, and it must be a version whose tarball
   already contains `mcpName`. Version 0.4.1 was published before `mcpName` existed, so the
   first registry publish cannot happen until 0.4.2 (or later) is on npm.
2. Only then can `mcp-publisher publish` succeed.

That is exactly why the registry publish is a `needs: publish` job inside `release.yml`
rather than a separate tag-triggered workflow — a second workflow would start in parallel
with the npm publish and fail validation against a version npm is not serving yet. The job
also polls `npm view` until the new version is visible, because npm's read path lags the
write by a few seconds.

### Version agreement

`server.json` carries the version twice (`version` and `packages[0].version`) and both must
equal `package.json`'s version. The release workflow fails fast if they drift, alongside the
existing tag-vs-package.json check. So a version bump is a three-line edit:

```bash
npm version patch --no-git-tag-version          # package.json
# then set the same version in server.json: .version and .packages[0].version
node -e '
  const fs=require("fs");
  const v=require("./package.json").version;
  const s=JSON.parse(fs.readFileSync("server.json","utf8"));
  s.version=v; s.packages[0].version=v;
  fs.writeFileSync("server.json", JSON.stringify(s,null,2)+"\n");
'
```

### Namespace casing is significant

The server name is `io.github.MohitBansal321/ai-usage-mcp` — matching the GitHub account's
canonical casing exactly, **not** lowercased. GitHub OIDC grants
`io.github.<repository_owner>/*` using the claim verbatim, and the registry's permission check
is a case-sensitive `strings.HasPrefix`
([`internal/auth/jwt.go`](https://github.com/modelcontextprotocol/registry/blob/main/internal/auth/jwt.go)).
A lowercase `io.github.mohitbansal321/...` would be granted nothing and fail with a 403. This
is a known open bug — [registry#689](https://github.com/modelcontextprotocol/registry/issues/689)
— and the maintainers' guidance there is to match your account's casing.

Because `mcpName` ships inside an immutable npm tarball, getting this wrong costs a whole npm
version to correct. Do not "tidy" the casing.

### Validating before you tag

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher validate server.json
```

### Confirming it landed

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.MohitBansal321/ai-usage-mcp"
```

---

## What cannot be undone

Treat a publish as permanent:

- **A version number can never be reused**, even after unpublishing. Publish `0.1.0` once.
- **Unpublishing is only allowed within 72 hours**, and only if nothing depends on it. After
  that the best you can do is `npm deprecate`.
- **The name is claimed** as soon as you publish.

If you want a rehearsal first, publish a prerelease that nobody will install by default:

```bash
npm version 0.1.0-rc.0 --no-git-tag-version
npm publish --tag next          # installable only via ai-usage-mcp@next
```

---

## Why installs won't break for users

The one native dependency, `better-sqlite3` v13, ships **prebuilt N-API binaries inside its
own npm tarball** for 8 platforms:

```text
darwin-arm64  darwin-x64        (macOS Apple Silicon + Intel)
linux-arm64   linux-x64         (glibc)
linuxmusl-arm64  linuxmusl-x64  (Alpine / musl)
win32-arm64   win32-x64         (Windows)
```

It declares `gypfile: false` and has no `install` script, so npm should never invoke a
compiler and never needs to reach GitHub for a binary. This matters: v11 of that library used
`prebuild-install`, which fetched binaries from GitHub releases at install time and had **no
build for Node 24 at all** — users on current Node would have needed Python and a C++
toolchain, and the install would fail without them.

**One exception, found by CI:** npm 10 **on Windows** ignores `gypfile: false` and runs
`node-gyp rebuild` anyway, which then fails on a machine with no toolchain. The same npm 10 on
macOS and Linux does not, and npm 11 does not on any platform. The bundled Windows prebuild is
perfectly usable — installing with `--ignore-scripts` on Windows + Node 22 loads and runs it
correctly. So this is an npm-version behaviour, not a packaging defect.

That is why `package.json` pins `better-sqlite3: ^13` and declares
`engines: { node: '>=22', npm: '>=11' }`, and why CI raises npm to 11 on every matrix leg
before installing.

If supporting npm 10 on Windows ever becomes a requirement, the fix is not to downgrade the
dependency (v11 has no Node 24 binaries) — it is to drop the native dependency entirely and
use Node's built-in `node:sqlite`, which needs no binary at all.

If you later need to support Node 20, do not downgrade the dependency — switch the storage
layer to Node's built-in `node:sqlite` instead.
