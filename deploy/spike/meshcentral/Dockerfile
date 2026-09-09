ARG NODE_BASE=node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
FROM ${NODE_BASE}

WORKDIR /opt/meshcentral
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p meshcentral-data meshcentral-files meshcentral-backups \
    && chown -R node:node /opt/meshcentral
COPY --chown=node:node provision.js meshctrl-secret.js ./

USER node
EXPOSE 4443
ENTRYPOINT ["node", "node_modules/meshcentral/meshcentral.js"]
