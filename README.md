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

## Offline-First Testing

1. Start the server and open the app once while online.
2. Confirm the page loads and shows `Online` in the status pill.
3. Turn off connectivity (DevTools Offline mode or phone airplane mode).
4. Reload the page:
   - The UI should still load (app shell from service worker cache).
   - Status should show `Offline`.
5. Add `COUNT`/`DELTA` changes:
   - `Queued events: N` should increase.
   - Events remain visible in the queued list.
6. Restore connectivity:
   - The app should auto-sync queued events.
   - `Queued events: N` should return to `0` after successful sync.
