#!/bin/bash
# Deploys MemoryBeat to an Ubuntu (arm64) server over SSH as a Docker container.
#
# No registry involved: the image is built locally for linux/arm64, saved to a
# gzipped tarball, scp'd into a subdirectory of the remote home dir, and loaded
# there. Usage:
#
#   ./deploy.sh
#   SERVER_IP=1.2.3.4 HOST_PORT=8080 ./deploy.sh
#   RESEED=1 ./deploy.sh    # push freshly rebuilt packs over the volume's copy
#
# The deploy target lives in deploy.env (gitignored -- copy deploy.env.example),
# or in the environment. It is deliberately not a default in this file: this
# script is public, and the host and account it deploys to need not be.

set -euo pipefail

cd "$(dirname "$0")"

# --- CONFIGURATION (deploy.env, overridable via environment) ---
# Environment wins: a var already set is left alone, so `SERVER_IP=x ./deploy.sh`
# still overrides the file.
if [ -f deploy.env ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    [ -n "${!key:-}" ] || export "$key=$value"
  done < deploy.env
fi

SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_IP="${SERVER_IP:-}"
TAG="${TAG:-latest}"
HOST_PORT="${HOST_PORT:-3000}"
RESEED="${RESEED:-0}"

if [ -z "$SERVER_IP" ]; then
  echo "No deploy target. Copy deploy.env.example to deploy.env and set SERVER_IP," >&2
  echo "or run: SERVER_IP=1.2.3.4 ./deploy.sh" >&2
  exit 1
fi

IMAGE_NAME="memorybeat"
TAR_NAME="${IMAGE_NAME}_${TAG}.tar"
GZ_NAME="${TAR_NAME}.gz"
# A subdirectory of the home dir, not /tmp: snap-installed Docker is sandboxed
# and cannot read the host's /tmp, so `docker load -i /tmp/...` fails with "no
# such file or directory" even though the file is right there.
REMOTE_DIR="/home/${SERVER_USER}/${IMAGE_NAME}-deploy"
VOLUME="${IMAGE_NAME}-data"

echo "🚀 Deploying ${IMAGE_NAME}:${TAG} to ${SERVER_USER}@${SERVER_IP}..."

# 1. Build for the server's architecture, not this machine's.
echo "📦 Building Docker image for linux/arm64..."
docker buildx build --platform linux/arm64 -t "${IMAGE_NAME}:${TAG}" --load .

# 2. Save + compress. Streaming through gzip keeps it to one pass over the image.
echo "💾 Saving and compressing image to ${GZ_NAME}..."
docker save "${IMAGE_NAME}:${TAG}" | gzip -c > "${GZ_NAME}"
echo "   ${GZ_NAME} is $(du -h "${GZ_NAME}" | cut -f1)"

# 3. Upload. scp won't create the target directory, so mkdir first.
echo "🚚 Uploading to ${REMOTE_DIR}..."
ssh "${SERVER_USER}@${SERVER_IP}" "mkdir -p '${REMOTE_DIR}'"
scp "${GZ_NAME}" "${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/${GZ_NAME}"

# 4. Load and run on the server. `docker load` detects gzip itself, so the
#    tarball never needs unpacking as a separate step.
echo "🌐 Executing remote deployment commands..."
RESEED_ENV=""
if [ "${RESEED}" = "1" ]; then RESEED_ENV="-e MEMORYBEAT_RESEED=1"; fi

ssh "${SERVER_USER}@${SERVER_IP}" bash -s <<EOF
set -e

echo "📥 Loading Docker image..."
sudo docker load -i "${REMOTE_DIR}/${GZ_NAME}"

echo "🧹 Stopping old container..."
sudo docker stop "${IMAGE_NAME}" 2>/dev/null || true
sudo docker rm "${IMAGE_NAME}" 2>/dev/null || true

echo "▶️  Starting new container..."
sudo docker volume create "${VOLUME}" >/dev/null
sudo docker run -d \
  --name "${IMAGE_NAME}" \
  --restart unless-stopped \
  -p ${HOST_PORT}:3000 \
  -v "${VOLUME}:/app/data" \
  ${RESEED_ENV} \
  "${IMAGE_NAME}:${TAG}"

echo "🧼 Pruning dangling images..."
sudo docker image prune -f >/dev/null

echo "🗑️  Removing uploaded tarball..."
rm -f "${REMOTE_DIR}/${GZ_NAME}"

sleep 2
sudo docker ps --filter "name=${IMAGE_NAME}" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
EOF

# 5. Only now is it safe to drop the local copy.
echo "🧹 Cleaning up local tarball..."
rm -f "${GZ_NAME}"

echo "✅ Deployment complete: http://${SERVER_IP}:${HOST_PORT}"
