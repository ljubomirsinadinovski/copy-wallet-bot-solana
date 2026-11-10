#!/usr/bin/env bash
# One-time setup of a fresh Hetzner Ubuntu 26.04 server for the bot. Run as root (see deploy/SERVER-SETUP.md):
#   scp deploy/setup-server.sh copy-wallet-ip:
#   ssh copy-wallet-ip bash setup-server.sh
# Safe to run again. Joining Tailscale, the GitHub deploy key, cloning and moving the bot stay manual
# (the guide's steps 3–6), because they need you in a browser.
set -euo pipefail
APP_DIR=/opt/copy-wallet
# The account that owns and runs the bot. Override: BOT_USER=name bash setup-server.sh
BOT_USER="${BOT_USER:-kestrel}"
REPO=git@github.com:ljubomirsinadinovski/copy-wallet-bot-solana.git

[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "root has no SSH key (/root/.ssh/authorized_keys is empty) – add your key first (guide step 1), then rerun."
  exit 1
fi

echo "==> System packages (upgrade everything, keep existing config files)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y -o Dpkg::Options::=--force-confold
apt-get install -y git sqlite3 curl rsync ufw ca-certificates unattended-upgrades

echo "==> Automatic daily security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> cloud-init off (first-boot setup is done; its network file in /etc/netplan stays)"
# Newer cloud-init looks for the wrong network card name (enp1s0 instead of eth0) on Hetzner Arm servers
# and marks the system "degraded" on every boot. The network itself comes from /etc/netplan/50-cloud-init.yaml.
if ls /etc/netplan/*.yaml >/dev/null 2>&1; then
  touch /etc/cloud/cloud-init.disabled
  systemctl reset-failed 'cloud-*' 2>/dev/null || true
else
  echo "   (no saved netplan file found – leaving cloud-init on)"
fi

echo "==> Docker (official install script)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && rm -f /tmp/get-docker.sh
fi
systemctl enable --now docker

echo "==> Tailscale (installed only; you join in the guide's step 3)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh -o /tmp/install-tailscale.sh && sh /tmp/install-tailscale.sh && rm -f /tmp/install-tailscale.sh
fi

echo "==> User '$BOT_USER' (uid 1000 = the bot's user inside the container, so both can use ./data)"
if ! id "$BOT_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -u 1000 "$BOT_USER"
fi
usermod -aG docker "$BOT_USER"
install -d -m 700 -o "$BOT_USER" -g "$BOT_USER" "/home/$BOT_USER/.ssh"
# Your laptop key (the one you used to log in as root) can log in as $BOT_USER too. Keys added later
# (e.g. the GitHub Actions key) are kept.
touch "/home/$BOT_USER/.ssh/authorized_keys"
cat /root/.ssh/authorized_keys "/home/$BOT_USER/.ssh/authorized_keys" | sort -u > /tmp/ak
install -m 600 -o "$BOT_USER" -g "$BOT_USER" /tmp/ak "/home/$BOT_USER/.ssh/authorized_keys" && rm -f /tmp/ak

echo "==> Read-only GitHub deploy key for the server"
if [ ! -f "/home/$BOT_USER/.ssh/github_deploy" ]; then
  sudo -u "$BOT_USER" ssh-keygen -q -t ed25519 -N "" -C "copy-wallet server (read-only)" -f "/home/$BOT_USER/.ssh/github_deploy"
fi
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' > "/home/$BOT_USER/.ssh/config"
ssh-keyscan -t ed25519 github.com 2>/dev/null >> "/home/$BOT_USER/.ssh/known_hosts"
sort -u -o "/home/$BOT_USER/.ssh/known_hosts" "/home/$BOT_USER/.ssh/known_hosts"
chown "$BOT_USER:$BOT_USER" "/home/$BOT_USER/.ssh/config" "/home/$BOT_USER/.ssh/known_hosts"
chmod 600 "/home/$BOT_USER/.ssh/config"

echo "==> App folder $APP_DIR"
install -d -o "$BOT_USER" -g "$BOT_USER" "$APP_DIR"

echo "==> SSH: keys only, never passwords"
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/99-keys-only.conf
sshd -t && systemctl try-reload-or-restart ssh

echo "==> Firewall: deny incoming except SSH (closed again in step 8) and Tailscale"
ufw allow OpenSSH
ufw allow 41641/udp
ufw allow in on tailscale0
ufw --force enable
ufw status verbose

cat <<MSG

Done. Next, in deploy/SERVER-SETUP.md:
  Step 3  Tailscale policy + HTTPS in the browser, then:
            tailscale up --hostname=copy-wallet --advertise-tags=tag:server
            tailscale serve --bg 8787
  Step 4  Add this key on GitHub → repo Settings → Deploy keys (leave "Allow write access" unchecked):

$(cat "/home/$BOT_USER/.ssh/github_deploy.pub")

          then test and clone:
            sudo -u $BOT_USER ssh -T git@github.com
            sudo -u $BOT_USER git clone $REPO $APP_DIR
MSG
if [ -f /var/run/reboot-required ]; then
  echo
  echo "  A system update needs a reboot ($(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null)): run 'reboot' now, wait a minute, log in again."
fi
true
