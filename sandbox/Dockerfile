# Default image for Atlas's container sandbox backend (`/sandbox container`,
# and the automatic Windows fallback — see
# packages/client/src/fileProxy/sandbox/container/docker.ts).
#
# Build once, then Atlas's default `sandbox.containerImage` ("atlas-sandbox:latest")
# picks it up automatically:
#
#   docker build -t atlas-sandbox:latest sandbox/
#
# Covers the common individual-developer toolchain (git, Node.js, Python,
# a C toolchain for native npm/pip deps). If your project needs something
# else, build your own image from this one and point `sandbox.containerImage`
# at it — nothing in Atlas assumes this exact image.

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
    python3-pip \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
