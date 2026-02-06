FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm install

COPY shared shared
COPY client client
COPY server server
COPY tsconfig.base.json tsconfig.base.json
COPY schema.sql schema.sql

RUN npm run build -w shared && npm run build -w server && npm run build -w client

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/package.json /app/package.json
COPY --from=base /app/package-lock.json /app/package-lock.json
COPY --from=base /app/server /app/server
COPY --from=base /app/shared /app/shared
COPY --from=base /app/client/dist /app/server/public
COPY --from=base /app/schema.sql /app/schema.sql
RUN npm install --omit=dev

WORKDIR /app/server
EXPOSE 3001
CMD ["node", "dist/index.js"]
