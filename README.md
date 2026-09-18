# InvApp

Simple offline-first inventory PWA prototype (server + client).

## Restarting the Server

The server normally runs headless, started automatically by the Windows Task Scheduler task **`INVAPP Server`** (a boot trigger, 1 minute delay) which runs `C:\InvApp\start-invapp-server.bat` as user `servi`. That script just `cd`s into `server\` and runs `npm start` (`node index.js`), listening on port 3000. There's no window to close — restart it via Task Scheduler or PowerShell.

**Recommended — restart the scheduled task** (PowerShell, run as the `servi` user or an admin):

```powershell
Stop-ScheduledTask -TaskName "INVAPP Server"
Start-ScheduledTask -TaskName "INVAPP Server"
```

You can also do this from the Task Scheduler GUI: open `taskschd.msc`, find **INVAPP Server** at the root of the task library, right-click → End, then right-click → Run.

**Manual fallback** — kill whatever is holding port 3000, then relaunch:

```powershell
# find and stop the process listening on port 3000
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -ExpandProperty OwningProcess | Stop-Process -Force

# relaunch the same way the scheduled task does
& "C:\InvApp\start-invapp-server.bat"
```

Note: the scheduled task only has a **Boot** trigger, so if you kill the process without going through Task Scheduler (or the batch file above), it will **not** come back until the next reboot or logon.

Run server manually / for development:

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
