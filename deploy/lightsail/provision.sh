#!/usr/bin/env bash
#
# One-time setup for a fresh Lightsail instance (Ubuntu 24.04).
#
# Idempotent: re-running it is the supported way to reconcile a drifted host, so every
# step either checks first or is naturally repeatable. It installs Docker, lays out
# the deployment directory, and closes the firewall — and it deliberately does *not*
# start anything, because there is no image tag yet. `deploy.sh` does that.
#
#   scp -r deploy/lightsail ubuntu@<ip>:/tmp/
#   ssh ubuntu@<ip> 'sudo bash /tmp/lightsail/provision.sh'

set -euo pipefail

APP_DIR=/opt/imgopt
APP_USER=${SUDO_USER:-ubuntu}

if [[ $EUID -ne 0 ]]; then
  echo "provision.sh must run as root (sudo bash provision.sh)." >&2
  exit 1
fi

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker
usermod -aG docker "$APP_USER" || true

echo "==> Laying out ${APP_DIR}"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
for file in docker-compose.yml Caddyfile deploy.sh; do
  install -m 0644 -o "$APP_USER" -g "$APP_USER" "$(dirname "$0")/${file}" "${APP_DIR}/${file}"
done
chmod 0755 "${APP_DIR}/deploy.sh"

# 0600, and never in the repository. It holds the database password, the AWS access
# key the control plane authenticates with, and the worker secret.
if [[ ! -f "${APP_DIR}/.env" ]]; then
  install -m 0600 -o "$APP_USER" -g "$APP_USER" /dev/null "${APP_DIR}/.env"
  echo "    created an empty ${APP_DIR}/.env — fill it in before deploying"
fi

echo "==> Firewall"
# Belt to Lightsail's own console-managed firewall, not a replacement for it. Both are
# needed: this one governs the instance, and Lightsail's governs what reaches it.
if command -v ufw >/dev/null 2>&1; then
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp  >/dev/null   # SSH
  ufw allow 80/tcp  >/dev/null   # ACME challenge + the HTTPS redirect
  ufw allow 443/tcp >/dev/null   # the API
  ufw --force enable >/dev/null
fi
# Port 3000 is deliberately absent. The API container publishes to 127.0.0.1 only, so
# it is unreachable from outside regardless — this is the second lock on that door,
# because the rate limiter trusts `x-forwarded-for` and that trust is only sound while
# Caddy is the sole way in.

echo "==> Reclamation schedule"
# 03:17 rather than 03:00: a round hour is when every other cron on every other host
# fires, and reclamation reads the whole bucket. The offset costs nothing.
cat > /etc/cron.d/imgopt-maintenance <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
17 3 * * * ${APP_USER} cd ${APP_DIR} && set -a && . ./.env && set +a && docker compose --profile scheduled run --rm maintenance >> /var/log/imgopt-maintenance.log 2>&1
CRON
chmod 0644 /etc/cron.d/imgopt-maintenance

cat > /etc/logrotate.d/imgopt <<'ROTATE'
/var/log/imgopt-maintenance.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
ROTATE

echo
echo "Provisioned. Next:"
echo "  1. Fill in ${APP_DIR}/.env       (see docs/bootstrap.md)"
echo "  2. ${APP_DIR}/deploy.sh <tag>"
