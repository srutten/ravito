# syntax=docker/dockerfile:1
#
# Image applicative Appui Feux, en plusieurs etapes.
#
#   base    : socle commun, outils minimaux
#   deps    : installation deterministe des dependances depuis package-lock.json
#   dev     : execution en developpement, rechargement a chaud, monte le code source
#   builder : construction de production
#   runner  : image de production, sortie standalone de Next uniquement
#
# L'etape runner ne contient ni code source, ni dependances de developpement,
# ni jeu de tests.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# curl sert aux sondes de sante des conteneurs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ---------------------------------------------------------------------------
FROM base AS deps
# Seuls les manifestes sont copies : la couche d'installation n'est invalidee
# que lorsque les dependances changent reellement.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    # Le code source est monte depuis le poste hote. Sur Windows et macOS, les
    # evenements du systeme de fichiers ne traversent pas la frontiere de
    # virtualisation : la surveillance doit fonctionner par scrutation.
    WATCHPACK_POLLING=true \
    CHOKIDAR_USEPOLLING=true
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# Le repertoire doit exister ET appartenir a node AVANT le montage du volume
# nomme : Docker recopie le contenu et les droits de l'image dans un volume
# vide. Sans cela, le volume appartiendrait a root et le serveur de
# developpement ne pourrait pas y ecrire.
RUN mkdir -p /app/.next && chown -R node:node /app/.next
USER node
EXPOSE 3000
# -H 0.0.0.0 : sans cela le serveur de developpement n'ecoute que sur la
# boucle locale du conteneur et reste injoignable depuis le poste.
CMD ["npm", "run", "dev", "--", "-H", "0.0.0.0"]

# ---------------------------------------------------------------------------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# La configuration Next produit une sortie standalone : cf. next.config.ts.
RUN npm run build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Le conteneur ne s'execute jamais en root.
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "server.js"]
