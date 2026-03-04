# InvApp

Simple offline-first inventory PWA prototype (server + client).

Run server:

```powershell
cd "c:\Users\servi\OneDrive\Documents\CAD Designer\CODE\InvApp\server"
npm install
npm start
```

Open http://localhost:3000 on your phone or desktop. The client is served from the `client/` folder.

Notes:
- The server uses SQLite and stores `events` and `items`.
- Client stores queued events in IndexedDB and syncs to `/api/events` when online.
