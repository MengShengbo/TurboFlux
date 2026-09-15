# Windows Desktop

TurboFlux Desktop targets Windows 10 22H2 and Windows 11 on x64. The shared kernel, workspace files and search, model connections, integrated browser, PowerShell terminal, encrypted Profile export/import, and Desktop remote control run on Windows. Computer automation is macOS-only.

## Development

Install Git for Windows and Node.js 22.12 or later in the Node 22 release line. Run these commands in PowerShell from the repository root:

```powershell
npm ci
npm run dev:desktop
```

The terminal uses Windows PowerShell 5.1 by default. To use PowerShell 7, set the executable before starting Desktop:

```powershell
$env:TURBOFLUX_POWERSHELL = 'C:\Program Files\PowerShell\7\pwsh.exe'
npm run dev:desktop
```

Both shells start without loading a user profile. Workspace paths may contain spaces or non-ASCII characters. The developer launcher invokes Node scripts directly, so paths do not pass through a command-shell quoting layer. The terminal uses ConPTY on supported Windows versions; ripgrep and native modules are bundled with the application.

## Packaging

Build on a Windows x64 machine:

```powershell
npm run package:win --workspace @turboflux/desktop
npm run verify:desktop:package
npm run qa:profiles:hidden -- --packaged
```

The NSIS installer is written under `release`. It supports choosing the installation directory and creating desktop and Start Menu shortcuts. An installed application does not require Node.js, Git, or a separate ripgrep installation. Git is needed only for Git-backed workspace operations. Native dependency rebuilds may require Visual Studio Build Tools with the Desktop development with C++ workload and Python.

Signing certificates are not included. Local builds and CI installers are unsigned unless signing credentials are configured; they are validation builds, not a signed public release. Windows ARM64 has not been qualified by the x64 CI job.

## Verification

CI runs the kernel and Desktop test suites on Windows, builds the NSIS installer, verifies installation to a directory containing spaces and uninstallation, loads the packaged native modules, and checks the packaged UI. UI acceptance covers Profile export/import and workspace rebind plus a real terminal session that writes output, resizes, exits, and closes. Only reports and screenshots are retained as Actions artifacts.
