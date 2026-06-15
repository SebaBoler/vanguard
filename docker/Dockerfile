# Vanguard sandbox image: node + git + the claude and linear CLIs, non-root user.
# Single stage so the global npm bins and their node_modules stay consistent (the linear-cli
# launcher resolves a sibling binary, which breaks when bins are copied across build stages).
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf
ARG CLAUDE_CLI_VERSION=2.1.165
ARG LINEAR_CLI_VERSION=latest
ARG CODEX_CLI_VERSION=latest

# xz-utils + ca-certificates: the linear-cli npm package downloads and untars an .xz release binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client xz-utils \
 && rm -rf /var/lib/apt/lists/*

# claude/codex run the agent (selectable via --provider/--review-provider); linear lets the agent use
# the linear-cli skill; pnpm lets it run the project's typecheck/tests from inside the sandbox before
# finishing. Codex authenticates with CODEX_API_KEY: in direct mode it is forwarded into the sandbox
# when codex is selected; under --llm-proxy the key is held by a trusted sidecar and the sandbox
# receives only a per-run nonce.
RUN npm install -g \
    @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    @schpet/linear-cli@${LINEAR_CLI_VERSION} \
    @openai/codex@${CODEX_CLI_VERSION} \
    pnpm

RUN groupadd -g 10001 agent \
 && useradd -m -u 10001 -g agent -s /bin/bash agent \
 && mkdir -p /workspace /home/agent/.claude \
 && chown -R agent:agent /workspace /home/agent

USER agent
WORKDIR /workspace
ENV HOME=/home/agent
CMD ["sleep", "infinity"]
