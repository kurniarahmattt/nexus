# Single-container e2e harness for Nexus.
#
# Includes Docker-in-Docker (DinD) so the wizard's `docker compose up`
# spins the full stack INSIDE this container — fully isolated from the
# host's other Docker workloads. Re-running the test does not affect
# anything on the host.
#
# Usage (driven by ../run.sh):
#   docker build -t nexus-e2e -f test/e2e/Dockerfile .
#   docker run --rm --privileged -v "$PWD:/src:ro" nexus-e2e
FROM docker:27-dind

# Tools the wizard + bootstrap scripts use. Alpine's busybox variants
# of grep/sed/find/etc. miss flags the scripts rely on (e.g. `grep -oP`
# for Perl regex in bootstrap-rocketchat.sh), so install the full GNU
# versions.
RUN apk add --no-cache \
      bash \
      git \
      tmux \
      openssl \
      curl \
      python3 \
      jq \
      ca-certificates \
      make \
      grep \
      sed \
      findutils \
      coreutils

# Bun. Honor BUN_INSTALL so the installer drops files directly under
# /usr/local/bun instead of $HOME/.bun (which on Alpine is /root/.bun
# but the installer doesn't always create that path consistently).
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=$BUN_INSTALL/bin:$PATH
RUN apk add --no-cache libstdc++ libgcc \
 && mkdir -p /usr/local/bun \
 && BUN_INSTALL=/usr/local/bun curl -fsSL https://bun.sh/install | bash \
 && /usr/local/bun/bin/bun --version

# Disable TLS on the in-container Docker socket — everything is loopback
# inside this container, no untrusted clients reach dockerd.
ENV DOCKER_TLS_CERTDIR=""

# docker:dind's official entrypoint only auto-starts dockerd when its
# first arg is `dockerd` (or a flag that begins with `-`). We use a
# shell script as CMD, so we have to start dockerd ourselves.
WORKDIR /work
ENTRYPOINT []
CMD ["sh", "-c", "\
set -e; \
echo '[e2e] starting dockerd in background'; \
dockerd > /var/log/docker.log 2>&1 & \
echo '[e2e] waiting for dockerd to accept connections...'; \
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done; \
docker info >/dev/null 2>&1 || { echo '[e2e] dockerd never came up; tail of /var/log/docker.log:'; tail -50 /var/log/docker.log; exit 1; }; \
echo '[e2e] dockerd ready'; \
exec bash /e2e/run-inside.sh"]
