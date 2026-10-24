# DeepCleaner

A Windows 11 cleaner with four modules: deep uninstall, large files, safe cache cleaning, and a similar-image scanner. The UI/UX design is in [`docs/design/deepcleaner-ui-ux.html`](docs/design/deepcleaner-ui-ux.html).

## Status

| Module | Status |
|---|---|
| 0. Safety core: PathGuard, quarantine (30 days), action history | ✅ |
| 3. Windows cache, whitelist only | ✅ |
| 2. Large files: treemap, filters, quarantine | ✅ |
| 1. Deep uninstall + leftovers | ⏳ next |
| 4. Similar images (better/worse) | ⏳ |

## Running

```bash
npm install
npm start        # build + launch the Electron app
npm test         # Vitest: safety, quarantine and cache tests
```

To clean Windows Temp, Windows Update downloads and system dumps, launch the app as administrator. Without admin rights those categories are skipped and the UI says so.

## Safety rules

- **Every** delete goes through `PathGuard` (`src/core/safety/pathGuard.ts`). It checks both the literal path and the real path (junctions, symlinks, 8.3 names). It refuses drive roots, `C:\Windows` except a few whitelisted subfolders, WinSxS, DriverStore, pagefile/hiberfil, registry hives, and the root user folders.
- The cache cleaner only cleans locations from `src/core/cache/cacheTargets.ts`, and passes each of them to the guard as `allowRoots`. The renderer only sends category IDs and never sends paths.
- Other modules delete into **quarantine** by default. Items can be restored for 30 days. The app's data folder is protected from all modules.
- Scans never follow links. Locked files are skipped and reported.

## Structure

```
src/core/      pure logic (safety, quarantine, cache), covered by Vitest tests
src/main/      Electron main: composition root + validated IPC
src/preload/   contextBridge API (sandbox, contextIsolation)
src/renderer/  UI (vanilla TS, Neon Cyber theme)
src/shared/    IPC contract + formatting
tests/         Vitest
```
