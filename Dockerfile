# syntax=docker/dockerfile:1
# AudioMaster in a container: Node builds the single-file app (npm run build →
# dist/index.html), an unprivileged nginx serves it on port 8080. Audio never reaches
# the container: songs are processed in the visitor's browser.
#   docker build -t audiomaster .
#   docker run --rm -p 8081:8080 audiomaster      → http://localhost:8081
# Published by .github/workflows/docker.yml as ghcr.io/maver404/audiomaster (compose.yaml).

# The page is the same on every architecture: build it natively, even in multi-arch builds.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html ./
COPY src ./src
COPY tools ./tools
RUN npm run build

FROM nginx/nginx-unprivileged:stable-alpine
LABEL org.opencontainers.image.title="AudioMaster" \
      org.opencontainers.image.description="In-browser automatic mastering for Suno songs" \
      org.opencontainers.image.source="https://github.com/Maver404/AudioMaster" \
      org.opencontainers.image.licenses="MIT"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
