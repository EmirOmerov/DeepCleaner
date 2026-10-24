# DeepCleaner

A Windows 11 cleaner with four modules: deep uninstall, large files, safe cache cleaning, and a similar-image scanner. The UI/UX design is in [`docs/design/deepcleaner-ui-ux.html`](docs/design/deepcleaner-ui-ux.html).

## Status

| Module | Status |
|---|---|
| 0. Safety core: PathGuard, quarantine (30 days), action history | ✅ |
| 3. Windows cache, whitelist only | ✅ |
| 2. Large files: treemap, filters, quarantine | ✅ |
| 1. Deep uninstall: native uninstaller, then leftovers (folders, shortcuts, registry with .reg backup) | ✅ |
| 4. Similar images: dHash grouping, quality score, BETTER/WORSE, slider comparison | ✅ |

## Running

```bash
npm install
npm start        # build + launch the Electron app
npm test         # Vitest: safety, quarantine and cache tests
```

### Installer (.exe)

```bash
npm run dist     # → release/DeepCleaner-Setup-<version>.exe
```

An NSIS installer that installs **per user, without administrator rights**. The user can choose the folder, and it creates Desktop and Start Menu shortcuts. `sharp` (image decoding) is unpacked outside the asar archive. The installer is not code-signed, so Windows SmartScreen will warn on first launch ("More info" → "Run anyway"). Signing requires a code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`).

To clean Windows Temp, Windows Update downloads and system dumps, launch the app as administrator. Without admin rights those categories are skipped and the UI says so.

## Safety rules

- **Every** delete goes through `PathGuard` (`src/core/safety/pathGuard.ts`). It checks both the literal path and the real path (junctions, symlinks, 8.3 names). It refuses drive roots, `C:\Windows` except a few whitelisted subfolders, WinSxS, DriverStore, pagefile/hiberfil, registry hives, and the root user folders.
- The cache cleaner only cleans locations from `src/core/cache/cacheTargets.ts`, and passes each of them to the guard as `allowRoots`. The renderer only sends category IDs and never sends paths.
- Other modules delete into **quarantine** by default. Items can be restored for 30 days. The app's data folder is protected from all modules.
- Scans never follow links. Locked files are skipped and reported.
- Similar images: grouping uses a 64-bit perceptual dHash with an adjustable threshold. The "better" image is chosen by resolution (35%), sharpness via Laplacian variance (30%), JPEG quality estimated from the quantization tables (15%), noise (10%) and EXIF (10%). The score is a **heuristic**: worse images are pre-selected, but nothing is deleted without confirmation, at least one image in every group always stays, and everything goes to quarantine.
- Deep uninstall: leftovers are searched **only after** the program has disappeared from the registry, so a cancelled or failed uninstall deletes nothing. Matching is conservative: only an exact name match is pre-selected, and publisher folders such as "Common Files" or "Microsoft" are never deleted. Registry keys go through `RegistryGuard`, which only allows `HKCU/HKLM\Software\<Vendor>` and never Microsoft, Classes or Policies. A `.reg` backup is exported before each delete.

## Structure

```
src/core/      pure logic (safety, quarantine, cache), covered by Vitest tests
src/main/      Electron main: composition root + validated IPC
src/preload/   contextBridge API (sandbox, contextIsolation)
src/renderer/  UI (vanilla TS, Neon Cyber theme)
src/shared/    IPC contract + formatting
tests/         Vitest
```
