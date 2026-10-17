# syntax=docker/dockerfile:1.7
#
# 3D Pinball: Space Cadet for the browser.
#
#   docker build -t spacecadet-web .
#   docker run -p 8080:8080 -v /path/to/pinball:/data:ro -v spacecadet:/config spacecadet-web
#
# Build stages run on the build machine's own architecture (WebAssembly and
# the front end are architecture-independent; Go cross-compiles), so a
# multi-arch image builds quickly without emulation.

ARG EMSDK_VERSION=3.1.52
ARG NODE_VERSION=22
ARG GO_VERSION=1.24

# --- 1. Game engine -> WebAssembly ---------------------------------------------
FROM --platform=$BUILDPLATFORM emscripten/emsdk:${EMSDK_VERSION} AS engine
# Decompiled engine (MIT): https://github.com/k4zmu2a/SpaceCadetPinball
ARG SCP_REPO=https://github.com/k4zmu2a/SpaceCadetPinball.git
ARG SCP_COMMIT=cb9b7b886244a27773f66b0b19fdc2998392565e
WORKDIR /src
RUN git init -q . \
 && git remote add origin "$SCP_REPO" \
 && git fetch -q --depth 1 origin "$SCP_COMMIT" \
 && git checkout -q FETCH_HEAD
COPY engine/patches/ /patches/
COPY engine/web/ Platform/Web/
RUN git apply --whitespace=nowarn /patches/*.patch
RUN emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)" \
 && ls -l bin/pinball.mjs bin/pinball.wasm

# --- 2. Front end -------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY --from=engine /src/bin/ ./engine-dist/
# SoundFont used for the table music (32 MB, loaded on demand).
# Set SOUNDFONT_URL="" to leave it out; players can still supply gm.dls.
ARG SOUNDFONT_URL=https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/684543d5e5efaef08d02be50dcda8d552478fa60/GeneralUser-GS.sf2
ARG SOUNDFONT_NAME="GeneralUser GS"
RUN SOUNDFONT_URL="$SOUNDFONT_URL" SOUNDFONT_NAME="$SOUNDFONT_NAME" node build.mjs

# --- 3. Server ----------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/spacecadet . \
 && mkdir -p /out/rootfs/config /out/rootfs/data

# --- 4. Runtime: one static binary and the built site ------------------------
FROM scratch
COPY --from=server /out/rootfs/ /
COPY --from=server /out/spacecadet /spacecadet
COPY --from=web /web/dist/ /www/
ENV PORT=8080 \
    WEB_ROOT=/www \
    DATA_DIR=/data \
    STATE_DIR=/config \
    PUID=1000 \
    PGID=1000
EXPOSE 8080
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/spacecadet", "-healthcheck"]
ENTRYPOINT ["/spacecadet"]
