# Flutter on Windows — Engineer Hub mobile setup

End-to-end setup for building the Engineer Hub mobile app with Flutter on a Windows
machine, from a clean install to a "Hello World" app running on an Android emulator.

**Nothing in this guide touches the live site.** All of it is local tooling on your
Windows machine — `www.engineerhuub.com`, the Vercel deployment, and the Neon
database are untouched. The only network call anything here makes to production is a
read-only `GET /api/election-status`, which is the same request any visitor's browser
makes.

Companion files:

| File | Purpose |
| --- | --- |
| [`flutter/main.dart`](flutter/main.dart) | Hello World + live API smoke test — paste over `lib/main.dart` |
| [`flutter/verify-flutter-setup.ps1`](flutter/verify-flutter-setup.ps1) | Read-only PowerShell script that checks every step below |

---

## Before you start

| Requirement | Detail |
| --- | --- |
| OS | Windows 10 (64-bit, version 1809+) or Windows 11, on x86-64 |
| Disk | **~20 GB free.** Flutter SDK ~3 GB, Android Studio + SDK ~10 GB, one emulator image ~4 GB, Gradle/pub caches ~2 GB |
| RAM | 8 GB minimum, 16 GB strongly recommended (the emulator alone wants 2–4 GB) |
| BIOS | Hardware virtualisation (Intel VT-x / AMD SVM) **enabled** — the emulator is unusably slow without it |

Run everything below in **PowerShell**, not `cmd`. Open a *new* terminal after any
`PATH` change — existing terminals keep the old environment.

---

## Step 0 — Prerequisites (5 minutes)

### Git for Windows

Flutter's tooling shells out to `git` for version checks and package resolution.

1. Download and install from <https://git-scm.com/download/win> (accept all defaults).
2. Verify in a new PowerShell window:

```powershell
git --version
```

### Enable Windows Developer Mode

Flutter plugins use symlinks, which need Developer Mode on Windows.

```powershell
start ms-settings:developers
```

Toggle **Developer Mode** to **On** and accept the prompt.

---

## Step 1 — Install the Flutter SDK

### 1.1 Download

Go to <https://docs.flutter.dev/get-started/install/windows/mobile> and download the
current **stable** `flutter_windows_<version>-stable.zip`.

Use the official page rather than a version pinned here — Flutter ships a stable
release roughly every quarter, and you want the current one.

### 1.2 Extract to a safe path

The destination path **must not** contain spaces or special characters, must not need
admin rights, and must not be inside a cloud-synced folder (OneDrive will corrupt the
SDK).

- ✅ `C:\src\flutter`
- ❌ `C:\Program Files\flutter` (needs elevation)
- ❌ `C:\Users\<you>\OneDrive\flutter` (sync corruption)
- ❌ `C:\Users\<you>\Documents\My Projects\flutter` (spaces)

```powershell
New-Item -ItemType Directory -Force -Path C:\src | Out-Null

# Adjust the filename to match what you downloaded.
Expand-Archive -Path "$env:USERPROFILE\Downloads\flutter_windows_stable.zip" `
               -DestinationPath C:\src -Force
```

You should end up with `C:\src\flutter\bin\flutter.bat`.

### 1.3 Add Flutter to your PATH

```powershell
$flutterBin = 'C:\src\flutter\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ($userPath -notlike "*$flutterBin*") {
    [Environment]::SetEnvironmentVariable(
        'Path',
        ($userPath.TrimEnd(';') + ';' + $flutterBin),
        'User'
    )
    Write-Host 'Added Flutter to User PATH. Open a NEW terminal.' -ForegroundColor Green
} else {
    Write-Host 'Flutter already on PATH.' -ForegroundColor Yellow
}
```

**Close PowerShell and open a new window.** Then:

```powershell
flutter --version
```

### 1.4 First run

```powershell
flutter doctor
```

The first invocation downloads the bundled Dart SDK and builds a tooling snapshot —
this takes 2–5 minutes. Expect red ✗ marks for Android at this point; that's Step 2.

> **If `flutter` isn't recognised:** the PATH change didn't land or you're in an old
> terminal. Check with `$env:Path -split ';' | Select-String flutter`.

---

## Step 2 — Install Android Studio

Even though you'll write code in VS Code, Android Studio is how you get the Android
SDK, build-tools, platform-tools, and the emulator.

### 2.1 Install

1. Download from <https://developer.android.com/studio>.
2. Run the installer with defaults.
3. Launch it and complete the **Setup Wizard**, choosing **Standard** install. It
   downloads the Android SDK, an SDK platform, build-tools, and the emulator
   (several GB — let it finish).

### 2.2 Install the command-line tools (required — easy to miss)

`flutter doctor` fails without this and the error is easy to skim past.

1. Android Studio → **More Actions** (or **Settings**) → **SDK Manager**
2. Tab: **SDK Tools**
3. Tick **Android SDK Command-line Tools (latest)**
4. Also confirm **Android SDK Platform-Tools** and **Android Emulator** are ticked
5. **Apply** → **OK**

### 2.3 Accept the Android licenses

```powershell
flutter doctor --android-licenses
```

Press `y` at each prompt. If this errors with a Java/JDK complaint, point Flutter at
Android Studio's bundled JDK:

```powershell
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
```

### 2.4 Re-check

```powershell
flutter doctor
```

Android toolchain should now be a ✓.

---

## Step 3 — VS Code + Flutter and Dart extensions

### 3.1 Install VS Code

Download from <https://code.visualstudio.com/>. During install, tick **Add to PATH**
so the `code` command works.

### 3.2 Install the extensions

From PowerShell:

```powershell
code --install-extension Dart-Code.flutter
code --install-extension Dart-Code.dart-code
```

(The Flutter extension depends on the Dart one, so installing Flutter alone is
usually enough — installing both explicitly is harmless and makes the state obvious.)

Or via the UI: **Ctrl+Shift+X** → search `Flutter` → install the one published by
**Dart Code**.

### 3.3 Verify

1. **Ctrl+Shift+P** → type `Flutter: New Project` — the command should exist.
2. **Ctrl+Shift+P** → `Flutter: Run Flutter Doctor` — output appears in the terminal.

```powershell
code --list-extensions | Select-String -Pattern 'Dart-Code'
```

Should print `Dart-Code.dart-code` and `Dart-Code.flutter`.

---

## Step 4 — Set up the Android emulator

### 4.1 Enable hardware acceleration

Emulator performance depends on a hypervisor. On modern Windows, use **Windows
Hypervisor Platform (WHPX)** — it coexists with Hyper-V, Docker Desktop, and WSL2,
which the old Intel HAXM driver did not.

Run **PowerShell as Administrator**:

```powershell
dism.exe /Online /Enable-Feature /FeatureName:HypervisorPlatform /All /NoRestart
dism.exe /Online /Enable-Feature /FeatureName:VirtualMachinePlatform /All /NoRestart
```

**Reboot.**

> If your machine has virtualisation disabled at the firmware level, enable
> **Intel VT-x** / **AMD SVM Mode** in BIOS/UEFI first — no OS-level setting can
> substitute for it.

> Not running Hyper-V/WSL2 at all? The **Android Emulator hypervisor driver (AEHD)**
> from the SDK Manager's SDK Tools tab is an alternative. Don't install both.

### 4.2 Create a virtual device

1. Android Studio → **Device Manager** (phone icon in the right sidebar, or
   **More Actions → Virtual Device Manager**)
2. **Create Device** / **+**
3. Pick a phone — **Pixel 7** or **Pixel 8** are good defaults
4. System image: choose a recent **API level** (API 34 / 35) with an **x86_64** ABI.
   Click the download arrow next to it and wait.
5. Name it something like `Pixel_8_API_35` → **Finish**
6. Press **▶** to boot it

The first boot takes a few minutes. Once at the Android home screen, leave it running.

### 4.3 Confirm Flutter can see it

```powershell
flutter devices
```

You should see a line like `sdk gphone64 x86 64 (mobile) • emulator-5554 • android-x64`.

**Command-line alternative**, once an AVD exists:

```powershell
$emulator = "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe"
& $emulator -list-avds
& $emulator -avd Pixel_8_API_35
```

> **Prefer a real phone?** Enable **Developer options** → **USB debugging** on the
> device, plug it in via USB, accept the RSA prompt, and it shows up in
> `flutter devices` too. This is faster than the emulator on most laptops.

---

## Step 5 — Create the Hello World app

```powershell
New-Item -ItemType Directory -Force -Path C:\src\engineerhub | Out-Null
Set-Location C:\src\engineerhub

flutter create hello_world
Set-Location hello_world
```

`flutter create` scaffolds `lib/main.dart`, the Android/iOS/web/desktop host projects,
and `pubspec.yaml`.

### 5.1 Add the one dependency the sample uses

```powershell
flutter pub add http
```

### 5.2 Replace `lib/main.dart`

Copy [`docs/flutter/main.dart`](flutter/main.dart) from this repo over
`C:\src\engineerhub\hello_world\lib\main.dart`.

It renders **Hello World** and adds a button that calls the live, public, read-only
`GET https://www.engineerhuub.com/api/election-status`. That single screen proves the
whole chain works: Flutter SDK → Android build → emulator → device networking →
your production API.

### 5.3 Note on the INTERNET permission

Debug builds get `android.permission.INTERNET` automatically (Flutter's template puts
it in `android/app/src/debug/AndroidManifest.xml` for hot reload). **Release builds do
not.** Before your first release build, add this inside `<manifest>` in
`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Skipping this produces an app that works perfectly in testing and fails every network
call in production — a classic first-release bug.

---

## Step 6 — Run it on the emulator

With the emulator booted:

```powershell
Set-Location C:\src\engineerhub\hello_world
flutter run
```

The first build is slow (Gradle downloads dependencies — 3–10 minutes). Subsequent
builds take seconds.

**From VS Code instead:** open the `hello_world` folder, pick the emulator in the
bottom-right device selector, press **F5**.

While `flutter run` is attached:

| Key | Action |
| --- | --- |
| `r` | Hot reload — pushes code changes in under a second, keeps app state |
| `R` | Hot restart — rebuilds state from scratch |
| `q` | Quit |
| `o` | Toggle platform (Android/iOS rendering) |

Tap **Test Engineer Hub API** in the app. A green card with JSON means everything
works end to end.

---

## Step 7 — Confirm everything works

Run the verification script from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\flutter\verify-flutter-setup.ps1
```

It checks — without installing or changing anything — that Git, Flutter, Dart, the
Android toolchain and licenses, the VS Code extensions, an AVD, virtualisation,
Developer Mode, and the Engineer Hub API are all in place, then prints a PASS/FAIL
summary and exits non-zero if a required check failed.

Manual equivalent:

```powershell
flutter doctor -v
```

You are ready when the doctor output shows ✓ for:

- `[✓] Flutter`
- `[✓] Windows Version`
- `[✓] Android toolchain - develop for Android devices`
- `[✓] Android Studio`
- `[✓] VS Code`
- `[✓] Connected device (1 available)`

`[✗] Chrome` or `[✗] Visual Studio` only matter if you also target web or Windows
desktop — ignore them for a mobile app.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `flutter` not recognised | PATH change hasn't reached this terminal. Open a new PowerShell window. |
| `cmdline-tools component is missing` | Step 2.2 — install **Android SDK Command-line Tools (latest)**. |
| `Android license status unknown` | Run `flutter doctor --android-licenses` and press `y` at every prompt. |
| Emulator boots to a black screen / extremely slow | Virtualisation off. Check BIOS VT-x/SVM, then Step 4.1. |
| `Unable to locate Android SDK` | `flutter config --android-sdk "$env:LOCALAPPDATA\Android\Sdk"` |
| Gradle build hangs on first run | It's downloading dependencies. Give it 10 minutes before intervening. |
| `Building with plugins requires symlink support` | Enable Developer Mode (Step 0). |
| App can't reach an API | Confirm the emulator has internet (open Chrome inside it). For a **local** dev server, use `http://10.0.2.2:<port>`, not `localhost`. |
| SDK behaves oddly after moving folders | Never put the SDK in OneDrive. Re-extract to `C:\src\flutter`. |

---

## Next: the Engineer Hub mobile app

Things worth deciding before writing feature code:

**API base URL per environment.** Never hardcode it. Use `--dart-define`, as the
sample does:

```powershell
# Against production
flutter run --dart-define=API_BASE_URL=https://www.engineerhuub.com

# Against a local `vercel dev` on port 3000 — note 10.0.2.2, not localhost
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

**The emulator's localhost is not your machine's.** `10.0.2.2` is the alias for the
host loopback from inside the Android emulator. On a physical device over Wi-Fi, use
your machine's LAN IP instead.

**Cleartext HTTP is blocked by default** on Android 9+. Production is HTTPS so this is
fine, but a local `http://10.0.2.2:3000` dev server needs a debug-only network security
config. Keep that config in `src/debug/` so it can never ship in a release build.

**No secrets in the app bundle.** Anything compiled into a Flutter app is extractable —
`strings` on the APK is enough. API keys, the Neon connection string, and Resend
credentials stay server-side in Vercel environment variables. The mobile app talks only
to `/api/*`.

**Existing API surface** this repo already exposes (`api/*.js`, deployed as Vercel
Functions): `auth`, `engineers`, `candidates`, `stats`, `history`, `reports`, `meta`
(`election-status`, `audit-log`), `sms`, `export`, `import`. The mobile app should reuse
these rather than introducing a parallel backend.

> ⚠️ Per this repo's README, several mutating endpoints have no authentication. A
> mobile client makes that gap easier to find and exploit than a web UI does. Worth
> closing before the app is published, not after.
