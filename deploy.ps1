# Deploys MemoryBeat to an Ubuntu (arm64) server over SSH as a Docker container.
#
# No registry involved: the image is built locally for linux/arm64, saved to a
# gzipped tarball, scp'd into a subdirectory of the remote home dir, and loaded
# there. Usage:
#
#   .\deploy.ps1
#   .\deploy.ps1 -ServerIp 1.2.3.4 -HostPort 8080
#   .\deploy.ps1 -Reseed          # push freshly rebuilt packs over the volume's copy
#
# The deploy target lives in deploy.env (gitignored -- copy deploy.env.example),
# or is passed in. It is deliberately not a default in this file: this script is
# public, and the host and account it deploys to need not be.

param(
    [string]$ServerUser,
    [string]$ServerIp,
    [string]$Tag        = "latest",
    [int]$HostPort      = 0,
    # Overwrite data/ in the container volume with the image's baked-in copy.
    # Off by default so a redeploy doesn't discard the live iTunes cache.
    [switch]$Reseed
)

$ErrorActionPreference = "Stop"

# deploy.env fills in whatever was not passed on the command line, so an explicit
# -ServerIp always wins over the file.
$fromFile = @{}
$envPath = Join-Path $PSScriptRoot "deploy.env"
if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $fromFile[$Matches[1]] = $Matches[2].Trim()
        }
    }
}
if (-not $ServerIp)   { $ServerIp   = $fromFile['SERVER_IP'] }
if (-not $ServerUser) { $ServerUser = $fromFile['SERVER_USER'] }
if (-not $ServerUser) { $ServerUser = "ubuntu" }
if ($HostPort -eq 0) {
    $HostPort = if ($fromFile['HOST_PORT']) { [int]$fromFile['HOST_PORT'] } else { 3000 }
}

if (-not $ServerIp) {
    Write-Host "No deploy target. Copy deploy.env.example to deploy.env and set SERVER_IP," -ForegroundColor Red
    Write-Host "or run: .\deploy.ps1 -ServerIp 1.2.3.4" -ForegroundColor Red
    exit 1
}

$IMAGE_NAME = "memorybeat"
$TAR_NAME   = "${IMAGE_NAME}_${Tag}.tar"
$GZ_NAME    = "${TAR_NAME}.gz"
# A subdirectory of the home dir, not /tmp: snap-installed Docker is sandboxed
# and cannot read the host's /tmp, so `docker load -i /tmp/...` fails with "no
# such file or directory" even though the file is right there.
$REMOTE_DIR = "/home/${ServerUser}/${IMAGE_NAME}-deploy"
$VOLUME     = "${IMAGE_NAME}-data"

# $ErrorActionPreference = "Stop" does NOT catch failing native commands
# (docker/ssh/scp) -- only $LASTEXITCODE reveals those.
function Assert-LastExitCode($what) {
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$what failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Push-Location $PSScriptRoot
try {
    Write-Host "Starting deployment of ${IMAGE_NAME}:${Tag} to ${ServerUser}@${ServerIp}..." -ForegroundColor Cyan

    # 1. Build for the server's architecture, not this machine's.
    Write-Host "Building Docker image for linux/arm64..." -ForegroundColor Cyan
    docker buildx build --platform linux/arm64 -t "${IMAGE_NAME}:${Tag}" --load .
    Assert-LastExitCode "Build"

    # 2. Save the image, then gzip it. `docker save | gzip` isn't an option here:
    #    PowerShell pipes text, not bytes, and would corrupt the tarball.
    Write-Host "Saving image to ${TAR_NAME}..." -ForegroundColor Cyan
    docker save -o "${TAR_NAME}" "${IMAGE_NAME}:${Tag}"
    Assert-LastExitCode "docker save"

    Write-Host "Compressing to ${GZ_NAME}..." -ForegroundColor Cyan
    if (Test-Path $GZ_NAME) { Remove-Item $GZ_NAME }
    $in  = [System.IO.File]::OpenRead((Resolve-Path $TAR_NAME))
    try {
        $out = [System.IO.File]::Create((Join-Path $PSScriptRoot $GZ_NAME))
        try {
            $gzip = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
            try { $in.CopyTo($gzip) } finally { $gzip.Dispose() }
        } finally { $out.Dispose() }
    } finally { $in.Dispose() }
    Remove-Item $TAR_NAME
    $sizeMb = [math]::Round((Get-Item $GZ_NAME).Length / 1MB, 1)
    Write-Host "  ${GZ_NAME} is ${sizeMb} MB" -ForegroundColor DarkGray

    # 3. Upload. scp won't create the target directory, so mkdir first.
    Write-Host "Uploading to ${REMOTE_DIR}..." -ForegroundColor Cyan
    ssh "${ServerUser}@${ServerIp}" "mkdir -p '${REMOTE_DIR}'"
    Assert-LastExitCode "Remote mkdir"
    scp "${GZ_NAME}" "${ServerUser}@${ServerIp}:${REMOTE_DIR}/${GZ_NAME}"
    Assert-LastExitCode "Upload"

    # 4. Load and run on the server. `docker load` detects gzip itself, so the
    #    tarball never needs unpacking as a separate step.
    Write-Host "Executing remote deployment commands..." -ForegroundColor Cyan
    $reseedEnv = if ($Reseed) { "-e MEMORYBEAT_RESEED=1" } else { "" }
    $remoteCommands = @"
set -e

echo "Loading Docker image..."
sudo docker load -i "${REMOTE_DIR}/${GZ_NAME}"

echo "Stopping old container..."
sudo docker stop "${IMAGE_NAME}" 2>/dev/null || true
sudo docker rm "${IMAGE_NAME}" 2>/dev/null || true

echo "Starting new container..."
sudo docker volume create "${VOLUME}" >/dev/null
sudo docker run -d \
  --name "${IMAGE_NAME}" \
  --restart unless-stopped \
  -p ${HostPort}:3000 \
  -v "${VOLUME}:/app/data" \
  ${reseedEnv} \
  "${IMAGE_NAME}:${Tag}"

echo "Pruning dangling images..."
sudo docker image prune -f >/dev/null

echo "Removing uploaded tarball..."
rm -f "${REMOTE_DIR}/${GZ_NAME}"

sleep 2
sudo docker ps --filter "name=${IMAGE_NAME}" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
"@

    # Normalize to LF so bash on the remote host doesn't choke on trailing \r.
    $remoteCommands = $remoteCommands -replace "`r`n", "`n"
    ssh "${ServerUser}@${ServerIp}" $remoteCommands
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Remote deployment failed (exit $LASTEXITCODE). Local tarball kept for retry." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    # 5. Only now is it safe to drop the local copy.
    Write-Host "Cleaning up local tarball..." -ForegroundColor Cyan
    if (Test-Path $GZ_NAME) { Remove-Item $GZ_NAME }

    Write-Host "Deployment complete: http://${ServerIp}:${HostPort}" -ForegroundColor Green
}
finally {
    Pop-Location
}
