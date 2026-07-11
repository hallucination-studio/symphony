#!/usr/bin/env bash
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-dev}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/podium}"
REPO_URL="${REPO_URL:-https://github.com/hallucination-studio/symphony.git}"
REPO_REF="${REPO_REF:-main}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo or as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg lsb-release openssl ufw

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! swapon --show | grep -q /swapfile; then
  fallocate -l "${SWAP_SIZE}" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
if ! grep -q "^/swapfile " /etc/fstab; then
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
cat >/etc/sysctl.d/99-symphony-test.conf <<'EOF'
vm.swappiness=10
EOF
sysctl -p /etc/sysctl.d/99-symphony-test.conf

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
fi
usermod -aG docker "${DEPLOY_USER}"

if [[ -f /home/ubuntu/.ssh/authorized_keys && ! -f "/home/${DEPLOY_USER}/.ssh/authorized_keys" ]]; then
  install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  install -m 0600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /home/ubuntu/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
fi

install -d -m 0755 "${DEPLOY_DIR}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_DIR}"

if [[ -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}"
else
  sudo -u "${DEPLOY_USER}" git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${DEPLOY_DIR}/repo" 2>/dev/null \
    || sudo -u "${DEPLOY_USER}" git -C "${DEPLOY_DIR}/repo" pull --ff-only
  SOURCE_DIR="${DEPLOY_DIR}/repo/deploy/podium-test"
fi

install -m 0644 "${SOURCE_DIR}/docker-compose.yml" "${DEPLOY_DIR}/docker-compose.yml"
install -m 0644 "${SOURCE_DIR}/nginx.conf" "${DEPLOY_DIR}/nginx.conf"
rm -f "${DEPLOY_DIR}/Caddyfile"

if [[ ! -f "${DEPLOY_DIR}/.env" ]]; then
  install -m 0600 "${SOURCE_DIR}/.env.example" "${DEPLOY_DIR}/.env"
  podium_secret="$(openssl rand -hex 32)"
  postgres_password="$(openssl rand -hex 24)"
  sed -i "s/replace-with-a-long-random-secret/${podium_secret}/" "${DEPLOY_DIR}/.env"
  sed -i "s/replace-with-a-long-random-password/${postgres_password}/" "${DEPLOY_DIR}/.env"
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_DIR}/.env"
  echo "Created ${DEPLOY_DIR}/.env. Edit PODIUM_DOMAIN and Linear settings before starting."
fi

chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_DIR}/docker-compose.yml" "${DEPLOY_DIR}/nginx.conf"

ufw allow OpenSSH || true
ufw allow 80/tcp || true

systemctl enable --now docker
docker compose version

echo "Bootstrap complete."
echo "Next:"
echo "  1. Edit ${DEPLOY_DIR}/.env"
echo "  2. Run: cd ${DEPLOY_DIR} && docker compose pull && docker compose up -d"
