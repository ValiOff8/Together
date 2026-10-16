# Together

Simple, invite-only shared to-do lists with live updates and light/dark mode. Built with Node.js 24 and SQLite.

```sh
docker compose up -d --build
```

Open [localhost:3000](http://localhost:3000), create the owner account, and invite friends. Set up the owner before exposing the app publicly. Data persists in a Docker volume.

For hosting, copy `.env.example` to `.env` and set `APP_URL` to your public address. Use HTTPS for internet access; set `BIND_ADDRESS=0.0.0.0` for direct LAN access.

Without Docker: `npm start` (Node.js 24+, no installation needed). Tests: `npm test`.
