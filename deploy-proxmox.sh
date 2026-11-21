#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="/opt/winus-video"
echo "=== Winus Video — Proxmox Deploy ==="

# Create directory
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r . "$INSTALL_DIR/"
sudo chown -R "$(whoami):$(whoami)" "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Load pre-built images
echo "▸ Loading Docker images..."
docker load < backend.tar.gz
docker load < nginx.tar.gz
docker load < coturn.tar.gz
rm -f backend.tar.gz nginx.tar.gz coturn.tar.gz

# Restructure backend
mkdir -p backend/src
mv backend-src/* backend/src/
rmdir backend-src
mv package.json backend/
mv Dockerfile backend/

# Run deploy
bash deploy.sh
