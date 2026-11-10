# Setting up a new server

Do this once. After that, every merge to `main` deploys itself:

```
feature branch → pull request (CI tests it) → merge to main
  → GitHub Actions: tests → joins your Tailscale network → SSH to the server
  → server builds the new image while the old bot keeps trading → safe restart
  → checks /api/health → Telegram "🚀 Deployed …"  (or rolls back by itself and says why)
```

Nothing on the server is reachable from the internet. The UI, SSH and deploys all go through Tailscale, a
private network between your devices.

**Costs:**
- Server: about $6 a month (CAX11 plus its IPv4 address).
- Tailscale: free on the personal plan.
- GitHub Actions: free for a private repo up to 2,000 minutes a month. A deploy takes about 1 minute.

> **Never run two bots on the same wallets.** The lock file only protects one `data/` folder. A Mac bot and a
> server bot with copies of the same keys would double every trade. Step 6 *moves* the bot; it doesn't copy it.

Run commands **on your Mac** unless a step says **on the server**. Names used below (change them consistently
if you want others):

| Name | Meaning |
|---|---|
| `copy-wallet` | Tailscale hostname of the server, plus the SSH alias for the `kestrel` user |
| `copy-wallet-root` | SSH alias for root over Tailscale (admin tasks) |
| `copy-wallet-ip` | SSH alias for root over the public IP (only until step 8) |
| `kestrel` | the Linux user that owns and runs the bot (uid 1000) |
| `~/.ssh/hetznered25519` | your laptop's SSH key for the server (any key works; adjust the path) |
| `tailXXXX.ts.net` | your tailnet name, found on the Tailscale admin **DNS** page |

---

## 0. Before you start

- `main` must contain this folder, `deploy/`. The server always deploys `main`.
- Install Tailscale on the Mac (https://tailscale.com/download) and log in.
  - In the menu bar icon → **Exit Node**, choose **None**. If an old exit node (e.g. a Raspberry Pi) is
    selected and offline, you have no internet while Tailscale is on.
  - The menu only shows exit-node options while Tailscale is connected.
- Have an SSH key on the Mac. If you don't, create one:

  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/hetznered25519
  ```

  A passphrase is recommended. The Keychain will remember it.

## 1. Buy the server

Go to Hetzner Cloud (https://console.hetzner.cloud) → **Add server**:

| Setting | Choose |
|---|---|
| Type | **Cost-Optimized → Arm64 → CAX11** (2 vCPU, 4 GB RAM). If unavailable, the x86 option in the same box. Not "Regular Performance": 4× the price for speed the bot doesn't need |
| Location | **Falkenstein** or **Nuremberg**: Germany, close to Helius' Frankfurt region |
| Image | **Ubuntu 26.04** |
| Networking | Keep **public IPv4** (GitHub has no IPv6) and IPv6 |
| SSH keys | **Add SSH key**, paste `cat ~/.ssh/hetznered25519.pub`, **and make sure it's selected**. Without a selected key Hetzner emails a root password instead |
| Volumes, firewalls, backups | none |
| Name | `copy-wallet` |

Note the public IPv4 address. You'll also see an IPv6 /64 block; both belong to the same server.

Add an SSH alias for the public address. SSH only tries default key names (`id_ed25519`, …) on its own,
so name the key explicitly. Add this to `~/.ssh/config` (`open -e ~/.ssh/config`):

```
# copy-wallet server: root over the public IP (only until step 8)
Host copy-wallet-ip
  HostName SERVER_IPV4
  User root
  IdentityFile ~/.ssh/hetznered25519
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
```

Test it. Answer `yes` to the fingerprint question, which happens only the first time:

```bash
ssh copy-wallet-ip whoami
```

It should print `root` without asking for a password.

## 2. Run the setup script

```bash
scp deploy/setup-server.sh copy-wallet-ip:
```

```bash
ssh copy-wallet-ip bash setup-server.sh
```

This takes 3–5 minutes. The script does the following:

- **Updates:** upgrades all packages and turns on automatic daily security updates.
- **cloud-init:** turns it off. It finished its first-boot job, and newer versions mark Hetzner Arm servers
  "degraded" on every boot because they look for the wrong network card name.
- **Software:** installs git, sqlite3, rsync, ufw, Docker and Tailscale. Tailscale is only installed; you
  join it in step 3.
- **The `kestrel` user:** creates it with uid 1000 and Docker access, and gives it your laptop key.
- **GitHub key:** creates a read-only deploy key for GitHub and prints it.
- **SSH:** turns off password logins, so keys only.
- **Firewall:** denies all incoming traffic except SSH and Tailscale.

Lines saying `Failed to connect to … bus` while systemd upgrades are harmless.

If it ends with **"needs a reboot"**, reboot, wait a minute, then check that the server is healthy:

```bash
ssh copy-wallet-ip reboot
```

```bash
ssh copy-wallet-ip systemctl is-system-running
```

It should say `running`. If it says `degraded`, see which service failed with
`ssh copy-wallet-ip systemctl --failed`.

## 3. Tailscale

**3a. Policy.** In the admin console, go to **Access controls** (https://login.tailscale.com/admin/acls/file)
and add the `// NEW` parts to your policy. Keep whatever else is there.

**If your Mac or phone carry tags** (shown as `tagged-devices` in `tailscale status`), list those tags as
sources too. `autogroup:member` covers only untagged personal devices.

```jsonc
{
  "tagOwners": {
    // …your existing tags…
    "tag:server": ["autogroup:admin"], // NEW: the server
    "tag:ci":     ["autogroup:admin"], // NEW: GitHub's temporary deploy machine
  },
  "acls": [
    // …your existing rules…

    // NEW: your devices → the server (UI and SSH). Add your device tags if you use any, e.g. "tag:my-laptop".
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:server:*"] },
    // NEW: GitHub Actions → only SSH on the server (nothing else, not your Mac)
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:server:22"] },
  ],
}
```

The server gets no rule that lets it connect *to* your devices.

**3b. HTTPS.** Go to the admin **DNS** page. Keep MagicDNS on, click **Enable HTTPS**, and note your tailnet
name (`tailXXXX.ts.net`).

**3c. Join the server.** Open the link it prints and approve. Tagged devices never expire.

```bash
ssh copy-wallet-ip tailscale up --hostname=copy-wallet --advertise-tags=tag:server
```

Check it, and note the server's Tailscale IP (`100.x.y.z`) for step 7:

```bash
ssh copy-wallet-ip 'tailscale status && tailscale ip -4'
```

**3d. Make the UI reachable inside Tailscale only:**

```bash
ssh copy-wallet-ip tailscale serve --bg 8787
```

The first time, it says *"Serve is not enabled on your tailnet"* and prints a link. On that page, **uncheck
"Tailscale Funnel"**, because Funnel would publish the service to the whole internet. Keep HTTPS
certificates checked and enable. Then run the command again.

The UI will be at `https://copy-wallet.tailXXXX.ts.net` once the bot runs in step 6.

## 4. Get the code onto the server

1. Go to GitHub → repo → **Settings → Deploy keys → Add deploy key**.
   - Paste the key the script printed (`ssh-ed25519 … copy-wallet server (read-only)`).
   - Leave **Allow write access unchecked**.
   - To print the key again: `ssh copy-wallet-ip cat /home/kestrel/.ssh/github_deploy.pub`
2. Test it. GitHub should answer *"Hi ljubomirsinadinovski/copy-wallet-bot-solana! You've successfully
   authenticated…"*:

   ```bash
   ssh copy-wallet-ip sudo -u kestrel ssh -T git@github.com
   ```

3. Clone:

   ```bash
   ssh copy-wallet-ip sudo -u kestrel git clone git@github.com:ljubomirsinadinovski/copy-wallet-bot-solana.git /opt/copy-wallet
   ```

## 5. SSH aliases over Tailscale

Add these to `~/.ssh/config` on the Mac:

```
# copy-wallet server over Tailscale (everyday use – the pnpm server:* commands use this name)
Host copy-wallet
  HostName copy-wallet.tailXXXX.ts.net
  User kestrel
  IdentityFile ~/.ssh/hetznered25519
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes

# copy-wallet server as root over Tailscale (admin tasks only)
Host copy-wallet-root
  HostName copy-wallet.tailXXXX.ts.net
  User root
  IdentityFile ~/.ssh/hetznered25519
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
```

Test both:

```bash
ssh copy-wallet whoami
```

```bash
ssh copy-wallet-root whoami
```

They should print `kestrel` and `root`. The fingerprint question appears once more, because it's a new name
for the same server. The fingerprint is the same as in step 1.

## 6. Move the bot (Mac → server)

1. **Make sure nothing runs on the Mac.** This command should print nothing (an error from `docker` is fine):

   ```bash
   pgrep -fl "tsx|node.*dist/index.js"; docker ps
   ```

   Stop anything listed: press Ctrl+C on `pnpm dev`, or run `docker compose down`.
2. **Check `LIVE_TRADING` in your `.env`.** With `true`, the server trades real money **as soon as it starts**.
   Set `false` if you want to look first; you can change it on the server later.
3. **Copy the settings and data.** `data/` holds the encrypted wallet keys, groups, open positions and history:

   ```bash
   scp .env copy-wallet:/opt/copy-wallet/.env && ssh copy-wallet 'chmod 600 /opt/copy-wallet/.env && ls -l /opt/copy-wallet/.env'
   ```

   ```bash
   rsync -av --exclude bot.lock --exclude logs data/ copy-wallet:/opt/copy-wallet/data/
   ```

   The server's `.env` needs `KEYSTORE_PASSPHRASE` set, so the bot unlocks itself after restarts. Leave
   `SENDER_URL` unset; the default https endpoint already picks the nearest region.
4. **Retire the Mac's copy before the server starts:**

   ```bash
   mv data data-premigration
   ```

   Then edit the Mac's `.env` (`open -e .env`):
   - Add the new line `DATA_DIR=./data-dev`. It wasn't there before, so add it rather than looking for it.
   - Change these existing lines to `LIVE_TRADING=false`, `KEYSTORE_PASSPHRASE=`, `TELEGRAM_BOT_TOKEN=` and
     `TELEGRAM_CHAT_ID=`.

   `pnpm dev` now starts with an empty, paper-only setup that can't message your phone.
5. **First deploy, by hand:**

   ```bash
   ssh copy-wallet 'cd /opt/copy-wallet && bash deploy/remote-deploy.sh origin/main'
   ```

   The first build takes about 2–4 minutes. It ends with `🚀 Deployed <commit>`, which also arrives on Telegram
   along with the bot's start message.
6. **Check it:**
   - Open `https://copy-wallet.tailXXXX.ts.net`, log in, and look at the balance and **Traders**.
   - Then run:

   ```bash
   pnpm server:status
   ```

   It should show `"connected":true`, `"keysUnlocked":true`, a container that is `healthy`, and no errors.

## 7. Turn on auto-deploy

**7a. A key for GitHub Actions** (a second key, the other direction: GitHub → server). It only works from
Tailscale addresses:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions deploy" -f ~/.ssh/copy_wallet_ci
```

```bash
{ printf 'from="100.64.0.0/10,fd7a:115c:a1e0::/48" '; cat ~/.ssh/copy_wallet_ci.pub; } | ssh copy-wallet 'cat >> ~/.ssh/authorized_keys && tail -1 ~/.ssh/authorized_keys'
```

**7b. A Tailscale login for GitHub.** In the Tailscale admin, go to **Settings → OAuth clients** (or **Trust
credentials**) and generate one:

- scope: **Auth Keys → Write** only
- tag: `tag:ci`

The secret is shown only once.

**7c. GitHub settings.** Go to the repo → **Settings → Secrets and variables → Actions**.

| Secrets tab | Value |
|---|---|
| `TS_OAUTH_CLIENT_ID` | client ID from 7b |
| `TS_OAUTH_SECRET` | secret from 7b |
| `DEPLOY_SSH_KEY` | run `pbcopy < ~/.ssh/copy_wallet_ci`, then paste (including the `-----BEGIN/END` lines) |

| Variables tab | Value |
|---|---|
| `DEPLOY_HOST` | the server's Tailscale IP from 3c (`100.x.y.z`) |
| `DEPLOY_USER` | `kestrel` |
| `DEPLOY_ENABLED` | `true` |

Then delete the private key from the Mac. Only GitHub needs it:

```bash
rm ~/.ssh/copy_wallet_ci
```

**7d. Test.** Go to **Actions → Deploy → Run workflow** on `main`. Both jobs should be green, and the deploy
log should end with *"Already running … – nothing to do"*.

## 8. Lock it down

1. **Close public SSH.** First check that the Tailscale route works:

   ```bash
   ssh copy-wallet whoami
   ```

   ```bash
   ssh copy-wallet-root ufw delete allow OpenSSH
   ```

   ```bash
   ssh copy-wallet whoami
   ```

   - `copy-wallet-ip` stops working after this, as intended, so delete that block from `~/.ssh/config`.
   - If Tailscale ever breaks, Hetzner's web **Console** still gets you in.
2. **Turn on 2FA** (authenticator app or passkey) on **GitHub, your Tailscale login and Hetzner**.
   Whoever controls one of those can reach your wallets: a push to `main` deploys code.
3. Keep only trading money in the bot's wallets. Their keys are unlocked on the server by design.
4. *Optional:* rotate the Telegram bot token if it was ever shared.
   - In @BotFather, send `/revoke` and pick the bot.
   - Put the new token in the server's `.env`: `ssh -t copy-wallet nano /opt/copy-wallet/.env`
   - Run `pnpm server:reload`.

---

## Day to day

**Develop:**

```bash
git switch -c my-change
```

Work and test with `pnpm dev` (paper, `./data-dev`). Check `git branch --show-current` before committing,
then push the branch and open a pull request:

```bash
git push -u origin my-change
```

Merge the pull request when CI is green. About a minute later, Telegram says "🚀 Deployed".

**Debug from the laptop:**

| Command | What it does |
|---|---|
| `pnpm server:status` | running version, health, container state, errors/warnings of the last 24 h |
| `pnpm server:logs` / `pnpm server:logs 2h` | recent logs (default: the last hour) |
| `pnpm server:follow` | live logs (Ctrl+C stops watching, not the bot) |
| `pnpm server:db "select … "` | read-only SQL on the live database |
| `pnpm server:deploys` | recent deploys and rollbacks |
| `pnpm server:backup` | download the newest backup (made with `deploy/backup.sh`) into `backups/` |
| `pnpm server:restart` | safe restart |
| `pnpm server:reload` | apply edits to the server's `.env` |
| `pnpm server:ssh` | a shell in `/opt/copy-wallet` |

**Undo a bad deploy:**
- A deploy that fails its health check is rolled back automatically.
- Otherwise, revert the commit on GitHub (**Revert** on the merged PR) and merge that.
- To jump back right away, run
  `ssh copy-wallet 'cd /opt/copy-wallet && bash deploy/remote-deploy.sh <commit>'`. Still revert on `main`,
  or the next deploy brings the bad commit back.

**Restarts are safe.**
- A deploy or restart lets copies already in progress finish (up to 20 s) before stopping.
- After starting, the bot first recovers unfinished submitted swaps from their saved signatures.
- It then checks each watched wallet's last few transactions and copies any trade it missed that is younger
  than **max signal age**.
- Downtime is about 5–10 s, because the new image is built while the old bot keeps running.

**Backups:** none are scheduled. To make one by hand (e.g. before a risky change), run
`ssh copy-wallet /opt/copy-wallet/deploy/backup.sh`, then download it with `pnpm server:backup`.

**Server updates:**
- Security updates install daily by themselves.
- Now and then, check whether one needs a reboot: `ssh copy-wallet-root cat /var/run/reboot-required`.
- If it does, run `ssh copy-wallet-root reboot`. The bot comes back by itself.
