FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/together.sqlite
WORKDIR /app
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/app.mjs"]
