# Template: the Vanguard CONTROLLER image. It runs `vanguard watch` and starts sibling sandbox
# containers via the host docker socket (docker-out-of-docker). This is NOT the sandbox image
# (that is docker/Dockerfile -> vanguard-sandbox). Validate on your host/arch before relying on it.
FROM node:24-bookworm-slim

# docker CLI (control sibling sandboxes), git, gh (GitHub source + PRs), xz (linear-cli install).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg xz-utils docker.io \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.32.1 @schpet/linear-cli@2.0.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Preset the linear-cli skill so --skills is optional.
RUN git clone --depth 1 https://github.com/schpet/linear-cli /opt/linear-cli
ENV SKILLS_DIR=/opt/linear-cli/skills

ENTRYPOINT ["node", "dist/cli/index.js"]
