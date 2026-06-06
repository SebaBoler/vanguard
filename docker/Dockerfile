# Vanguard sandbox image: node + git + the claude and linear CLIs, non-root user.
FROM node:24-bookworm-slim AS base
ARG CLAUDE_CLI_VERSION=2.1.165
ARG LINEAR_CLI_VERSION=latest

FROM base AS builder
ARG CLAUDE_CLI_VERSION
ARG LINEAR_CLI_VERSION
# claude runs the agent; linear lets the agent use the linear-cli skill from inside the sandbox.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} @schpet/linear-cli@${LINEAR_CLI_VERSION}

FROM base AS final
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY --from=builder /usr/local/bin/linear /usr/local/bin/linear
RUN groupadd -g 10001 agent \
 && useradd -m -u 10001 -g agent -s /bin/bash agent \
 && mkdir -p /workspace /home/agent/.claude \
 && chown -R agent:agent /workspace /home/agent
USER agent
WORKDIR /workspace
ENV HOME=/home/agent
CMD ["sleep", "infinity"]
