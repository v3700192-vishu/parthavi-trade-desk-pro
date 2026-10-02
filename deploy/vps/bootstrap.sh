#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/parthavi/app
REPO_URL=https://github.com/v3700192-vishu/parthavi-trade-desk-pro.git

apt-get update
apt-get install -y git curl nginx

if ! id parthavi >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin parthavi
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node.split(".")[0],10)')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p /opt/parthavi
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

cp "$APP_DIR/deploy/vps/parthavi-trade-desk.service" /etc/systemd/system/parthavi-trade-desk.service
chown -R parthavi:parthavi /opt/parthavi

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown parthavi:parthavi "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env — fill broker variables before starting the app."
fi

sudo -u parthavi bash -lc "cd '$APP_DIR' && npm install"
systemctl daemon-reload
systemctl enable parthavi-trade-desk
systemctl restart parthavi-trade-desk
systemctl --no-pager --full status parthavi-trade-desk || true
