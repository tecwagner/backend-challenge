# =============================================================================
# Dockerfile — Wagering Processor
#
# Build multi-stage usando Bun 1.x Alpine.
#
# Estágios:
#   deps    — instala dependências de produção
#   build   — copia o código-fonte
#   runner  — imagem final mínima para execução
#
# Uso:
#   docker build -t wagering-processor .
#   docker run -p 3000:3000 --env-file .env wagering-processor
# =============================================================================

# ---------------------------------------------------------------------------
# Estágio 1: Instalar dependências
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copiar apenas os manifests de dependências primeiro para aproveitar cache Docker.
# O bun.lock garante reproducibilidade exata das versões instaladas.
COPY package.json bun.lock ./

# Instalar dependências de produção com versões fixas do lockfile
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Estágio 2: Build / preparação do código-fonte
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copiar dependências já instaladas do estágio anterior
COPY --from=deps /app/node_modules ./node_modules

# Copiar código-fonte e configurações
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/

# (Opcional) Se quiser um transpile antecipado para dist/:
# RUN bun build src/main.ts --outdir dist --target bun

# ---------------------------------------------------------------------------
# Estágio 3: Runner — imagem final de execução
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS runner

# Criar usuário não-root para segurança
RUN addgroup --system --gid 1001 wagering \
    && adduser --system --uid 1001 --ingroup wagering wagering

WORKDIR /app

# Copiar artefatos do estágio de build
COPY --from=build --chown=wagering:wagering /app/node_modules ./node_modules
COPY --from=build --chown=wagering:wagering /app/package.json ./package.json
COPY --from=build --chown=wagering:wagering /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=wagering:wagering /app/src ./src

# Usar usuário não-root
USER wagering

# Porta da aplicação NestJS/Fastify
EXPOSE 3000

# Variáveis de ambiente com valores padrão (sobrescritas via docker-compose ou --env-file)
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

# Comando de inicialização — Bun executa TypeScript nativamente sem transpile
CMD ["bun", "run", "src/main.ts"]
