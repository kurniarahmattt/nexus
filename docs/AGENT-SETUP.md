# Nexus Setup — Agent Brief

> **For the AI agent reading this**: you are helping a developer set up
> Nexus (https://github.com/kurniarahmattt/nexus). Follow the steps below
> precisely. Ask the developer questions in §0 before deciding which flow
> to run, then execute that flow one step at a time.
>
> **For the developer**: hand this file to your local AI agent (Claude
> Code, Cursor, Gemini CLI, etc.) and answer its questions. The agent
> will run the commands; you confirm each one.

---

## 0. Decide the flow

Ask the developer **exactly this question** and wait for an answer:

> "Do you want to **host Nexus** (run the full stack on this machine so
> teammates can connect to it), or **join an existing Nexus** as a bridge
> (your local CLI participates as a bot in someone else's room)?"

- Answer "host" or "self" or "full" → follow **§A. Host Setup**.
- Answer "join" or "bridge" or "client" → follow **§B. Bridge Setup**.
- If unclear, ask once more with examples; do not guess.

After picking a flow, do not switch — finish it cleanly. The developer can
re-run you for the other flow afterward.

---

## A. Host Setup

**Goal**: a working Nexus stack on this machine, reachable by team
members on the LAN (or via VPN / TLS proxy for off-LAN).

### A.1. Verify prerequisites

Run each command and confirm the version. If something is missing, ask
the developer for permission before installing — never install silently.

| Tool           | Check command           | Minimum   |
|----------------|-------------------------|-----------|
| Docker         | `docker --version`      | 24+       |
| Docker Compose | `docker compose version`| 2+        |
| Bun            | `bun --version`         | 1.2+      |
| tmux           | `which tmux`            | any       |
| Git            | `git --version`         | any       |
| openssl        | `which openssl`         | any       |
| Free disk      | `df -h .`               | 6 GB free |
| Free RAM       | `free -h`               | 6 GB+     |

If Bun is missing: ask permission, then `curl -fsSL https://bun.sh/install | bash`.
If tmux is missing on Debian/Ubuntu: ask permission, then `sudo apt install -y tmux`.

### A.2. Clone the repo

Ask: "Where would you like to clone Nexus? (e.g. `~/coding/nexus`)"
Then:

```bash
git clone https://github.com/kurniarahmattt/nexus.git <path>
cd <path>
```

If they prefer SSH and have a key set up, use `git@github.com:kurniarahmattt/nexus.git`.

### A.3. Configure secrets in `.env`

```bash
make setup
```

This copies `.env.example` → `.env`. Now you must edit five values. Read
the existing `.env` first, then **show the developer** each replacement
before applying it. Use `Edit` / `Write` tools rather than `sed -i`.

| Variable                    | Replacement                                       |
|-----------------------------|---------------------------------------------------|
| `NEXUS_WORKSPACE_ROOT`      | Ask the developer for an absolute path (e.g. `/home/<user>/coding`) |
| `ROCKETCHAT_ADMIN_PASSWORD` | `openssl rand -base64 24` |
| `POSTGRES_PASSWORD`         | `openssl rand -base64 24` |
| `NEXUS_WEBHOOK_TOKEN`       | `openssl rand -hex 24`    |
| `DATABASE_URL`              | Update the password segment to match the new `POSTGRES_PASSWORD` |

Also ask: "Which LLM provider should Mem0 use? (OpenAI, Anthropic via
gateway, local vLLM, etc.)" — and update `MEM0_LLM_PROVIDER`,
`MEM0_LLM_MODEL`, `MEM0_LLM_BASE_URL`, `MEM0_LLM_API_KEY` accordingly.
If they want to skip memory for now, leave the dev defaults but warn
them recall will not work until set.

After editing, show the diff (without showing actual secret values — say
e.g. `ROCKETCHAT_ADMIN_PASSWORD=<32 chars set>`) and confirm.

### A.4. Install JS dependencies

```bash
make install
```

### A.5. Start the infra stack

```bash
make up
```

Wait ~60 seconds (Rocket.Chat first-boot). Then:

```bash
make health
```

All five services should report healthy: Rocket.Chat HTTP 200, Postgres
accepting connections, Redis PONG, Mongo OK, mem0-api HTTP 200. If any
fail, check `make logs-rocketchat` / `make logs` and diagnose before
continuing — do not skip.

### A.6. Start the host services

```bash
make services-up
```

Verify:

```bash
make services-status
```

`gateway` (4000), `composer` (4001), and `runtime` (4002) should respond.

### A.7. Bootstrap Rocket.Chat

```bash
make bootstrap
```

This creates the admin user, the initial `@claude` and `@hermes` bots,
and a `#nexus-test` channel. Note the credentials it prints and save
them somewhere safe.

### A.8. Verify end-to-end

Open `http://localhost:3000` in the developer's browser. Tell them to:
1. Log in with the admin credentials from A.7.
2. Open `#nexus-test`.
3. Type `@claude hello` and confirm the bot replies within a few seconds.

If the bot does not reply, check `make services-status` and tail the
runtime logs (`tmux attach -t nexus`, switch to the runtime window).

### A.9. Hand-off

Tell the developer: "Nexus is running. To onboard a teammate, run
`make create-bridge USER=<their-username> NAME=<role> CLI=<claude|cursor|gemini|hermes> CWD=<their-workspace-on-their-machine>`,
then send them the slug, token, config file, and your gateway URL
(`ws://<your-LAN-IP>:4000/bridge`). They can use the **§B. Bridge Setup**
flow with their own AI agent."

---

## B. Bridge Setup

**Goal**: this developer's local CLI joins an existing Nexus instance as
a bot. The Nexus host is run by someone else (or by the same developer
on a different machine).

### B.1. Collect inputs

Ask the developer for these four things. Do not proceed until you have
all four:

1. **Gateway URL** — e.g. `ws://192.168.1.100:4000` or `wss://nexus.team.com`.
2. **Bridge config file** — a JSON file the host admin generated via
   `make create-bridge`. Path on disk, e.g. `~/Downloads/claude-alice-backend.json`.
3. **Bridge token** — a long hex string the host admin gave them
   separately (do **not** ask them to paste it into chat — ask for the
   path to a file containing it, or read it from an env var they set).
4. **CLI to bridge** — `claude`, `cursor-agent`, `gemini`, or `hermes`.

If they don't have items 2 or 3, stop. Tell them: "Ask your Nexus host
admin to run `make create-bridge USER=<your-username> NAME=<role>
CLI=<cli> CWD=<your-workspace-path>` on the host. They will give you a
slug, token, and config file."

### B.2. Verify the CLI binary

```bash
which <cli>          # claude / cursor-agent / gemini / hermes
<cli> --version      # confirm it runs
```

If missing, point them at the CLI's installer:
- claude → https://docs.anthropic.com/claude/docs/claude-code
- cursor-agent → https://cursor.com/cli
- gemini → https://github.com/google-gemini/gemini-cli
- hermes → vendor-specific.

### B.3. Verify Bun is available

```bash
bun --version
```

If missing, ask permission and `curl -fsSL https://bun.sh/install | bash`.

### B.4. Stage the config file

Pick a stable location (ask the developer; default `~/.nexus/`):

```bash
mkdir -p ~/.nexus
cp <their-downloaded-config>.json ~/.nexus/
```

### B.5. Read and confirm the persona

Open the config JSON. Show the developer the `display_name`,
`description`, and `persona` fields. Ask: "Is this the persona you want?
Edit now if not — it is the system prompt your AI partner uses on every
mention."

If they want to edit, do so via `Edit`/`Write` tools.

### B.6. Get the bridge bundle

The Nexus host typically serves a pre-built bridge bundle. Ask:
"Can you reach `<gateway-base-url>/admin/download/nexus-bridge.js` from
this machine?" If yes:

```bash
curl -fsSL <gateway-base-url>/admin/download/nexus-bridge.js \
  -o ~/.nexus/nexus-bridge.js
```

If the host doesn't expose that endpoint or the developer prefers source:

```bash
git clone https://github.com/kurniarahmattt/nexus.git ~/.nexus/repo
cd ~/.nexus/repo && bun install
```

### B.7. Run the bridge

If you fetched the bundle:

```bash
NEXUS_BRIDGE_TOKEN=<token> \
  bun ~/.nexus/nexus-bridge.js \
    --config ~/.nexus/<slug>.json \
    --server <gateway-url>/bridge
```

If you cloned the source:

```bash
cd ~/.nexus/repo
NEXUS_BRIDGE_TOKEN=<token> \
  bun packages/nexus-bridge/bin/nexus-bridge.ts \
    --config ~/.nexus/<slug>.json \
    --server <gateway-url>/bridge
```

Watch for the line `bridge authenticated`. If you see reconnect loops,
double-check the token (no leading/trailing whitespace) and the URL
(should end in `/bridge`).

### B.8. Make it persistent (optional, recommended)

Ask: "Do you want this bridge to keep running in the background and
restart on reboot?" If yes, offer the developer one of:

- **systemd user unit** at `~/.config/systemd/user/nexus-bridge.service`,
  enabled with `systemctl --user enable --now nexus-bridge`. Write the
  unit file for them after confirming the slug + token storage location.
- **tmux session**: `tmux new -d -s nexus-bridge '<the bun command>'`
  (volatile across reboots, fine for laptops).

Pick whichever they prefer. Show them how to view logs and restart.

### B.9. Verify in chat

Tell the developer to ask the host admin to run:

```bash
make invite-bot SLUG=<slug> CHANNEL=<channel-name>
```

(They cannot do this themselves unless they have admin access to the
host.) Then have them open the host's Rocket.Chat URL in a browser, log
in (the host admin should have created a user account for them), open
the channel, and `@<slug> hello` to test.

---

## Rules for the agent (apply to both flows)

- **Always show the command before running it.** Never run side-effecting
  commands silently.
- **Ask permission for anything destructive**: writing files outside the
  Nexus checkout, installing system packages, modifying shell rc files,
  opening network ports.
- **Verify each step's output** before claiming success. If a health
  check fails, do not move on.
- **Never paste secrets** into chat. Generate, store in `.env` or a file,
  and reference by path or env var afterward.
- **Capture failure context**. If a command fails, save the last 50
  lines of output and offer specific next actions — don't blindly retry.
- **Treat the developer as a peer engineer.** Skip explanations of
  trivial commands; explain only non-obvious choices.
- **Keep replies short.** After each step, one sentence on what worked,
  then prompt for continue.
- **Do not modify code or schemas** in this flow. The job is setup, not
  customization. If the developer asks you to change something
  fundamental, finish setup first, then handle the change as a separate
  task.
- **Stop on ambiguity.** If you can't tell which flow they want, or a
  config value is unclear, ask — don't guess.

## When you finish

After the developer confirms the smoke test works (A.8 or B.9):

1. Print a short success summary listing what's running and where.
2. Save a one-line note in their shell: ask whether to add a comment or
   alias — do not modify rc files without explicit consent.
3. Point them at:
   - `README.md` (Nexus overview)
   - `PLANNING.md` (architecture)
   - `docs/BRIDGES.md` (deeper bridge setup)
   - `make help` (every Make target)

Then exit cleanly. Do not start a second flow unprompted.
