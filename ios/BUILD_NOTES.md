# Build notes for the first local build

All of `ios/` after the upstream import was written on Linux, with no Xcode. Two checks were
possible there:

- **Syntax**: every file passes `swiftc -parse` with Swift 6.4.1 (`docker run swift:6.4-noble`).
- **Review**: a read-through for type errors, API signatures and actor isolation.

Neither replaces a compile, so expect a few fixes on the first Xcode 27 build. This file lists
what is most likely to need attention, file by file, and what to check on the iPhone 13 Pro.

## Generating the project

- Run `cd ios && xcodegen generate`. It writes `Ayna.xcodeproj`, which is git-ignored, and
  rewrites `Ayna/Info.plist` from `project.yml`. Keep the two in sync and edit `project.yml`.
- Under *Build Phases → Copy Bundle Resources*, check that the Ayna target has:
  - the fonts: `Michroma-Regular.ttf`, `Doto-Bold.ttf`, `Doto-Black.ttf`;
  - `OFL-Michroma.txt` and `OFL-Doto.txt`. They have different names on purpose: two files
    called `OFL.txt` would collide in the flat app bundle ("Multiple commands produce").
  - `Support.json`, `PrivacyPolicy.json`, `PrivacyInfo.xcprivacy` and `Assets.xcassets` (AppIcon
    plus the `LaunchBackground` colour used by `UILaunchScreen`).
- Signing: pick the team in Xcode. `DEVELOPMENT_TEAM` is deliberately not in `project.yml`.

## Fonts

- SwiftUI finds the fonts by PostScript name: `Michroma-Regular`, `Doto-Bold` and `Doto-Black`
  (constants in `AynaTheme`). This was verified with fontTools on the files themselves. If text
  shows in SF Pro on the device, log `UIFont.fontNames(forFamilyName: "Doto")`,
  `"Doto Black"` and `"Michroma"` and adjust the constants.
- The Doto instances use `ROND=100` (round dots, like LiDAR points), which the brief did not
  specify. For square pixels instead, regenerate with `ROUND_DOTS = 0` in
  `tools/make_doto_static.py`.

## Places that may not compile as written

| File | Where | Risk | Fix if it fails |
|---|---|---|---|
| `AynaDesign.swift` | top-level `enum AynaTheme` | It is not named `Ayna`, because a type with the module's name breaks module-qualified lookups such as the SwiftUI preview thunks. | — |
| `AynaDesign.swift` | `actor MirrorThumbnails` uses `AynaTheme.uiSurface` / `uiNeutral` | static `UIColor`s used from an actor: a Sendable warning in Swift 5 mode | make the colours computed, or build them inside the actor |
| `Coverage.swift` | `CoverageMap`: `TimelineView(.animation(minimumInterval:paused:))`, `Canvas`, `GraphicsContext.Shading.conicGradient`, CGFloat ↔ Double in `.radians(...)` | overload resolution or isolation of the Canvas renderer closure | wrap the angles in `Double(...)`; mark `draw`/`projection` `nonisolated` if the renderer closure is nonisolated in the SDK |
| `CaptureController.swift` | `ResumeOnce<T>` and `heroStill()` | `withCheckedContinuation` carries a non-Sendable `ARFrame`; `captureHighResolutionFrame`'s completion queue | Swift 5 mode should only warn; if it errors, resume with the `Shot` built on the main actor instead of the frame |
| `CaptureController.swift` | `save(_:manual:hero:) -> Bool` with `@discardableResult` | low | — |
| `CaptureScreen.swift` | `.onChange(of: controller.phase)` with `case .betweenRooms where …` | low | rewrite as `if next == .betweenRooms && !controller.rooms.isEmpty` |
| `HeroShotView.swift` | `FramingGuide`: tuples mixing `CGFloat` and `1.0` literals | low; same pattern as upstream `FieldworkCorners`, which compiled | annotate as `[(CGFloat, CGFloat, CGFloat, CGFloat)]` |
| `HomeScreen.swift` / `MirrorScreen.swift` | `Task.detached` closures capture `ScanBundle` values | they capture `let` copies only, so it should be fine | — |

The upstream sources that the new code calls (`PreviewModel`, `PreviewScene.scene/.view`,
`PreviewSource.session`, `ThumbnailStore.upright`, `HouseProject.deleteSession/renameRoom`,
`MeshAsset`, `PLYMesh`) are unchanged.

## What to check on the iPhone

**Home**

- The logo: the dotted, flipped "AYNA" should sit centred under each Michroma letter with a small
  gap. The spacing (`-0.41 × size`) comes from the font metrics.
- The circle strip, the lime *New scan* card, the mirror list with clay thumbnails, the info button.

**Scan**

- The camera permission prompt reads: "Ayna uses the camera and LiDAR to build a physical mirror
  of your space."
- The scan starts about 0.35 s after the cover appears. If it stays on the *New scan* card, the
  storage check failed (500 MB free is required).
- Mesh colours: orange below `goodScore`, lime from it. A short lime flash marks triangles a new
  photo just covered. If the flash never shows, set `flashMaterial.readsFromDepthBuffer = false`
  in `ScanView.swift`. If it is too strong, lower its `transparency`.
- Radar: heading-up, so a wall in front of you appears above the centre. Turning the phone left
  should rotate the dots to the right. Check that the beam sweeps, the field-of-view wedge points
  up, and walls and furniture show as lime or orange dots. The Canvas redraws at 30 fps; if
  scanning gets choppy, drop it to 20 fps or pause the beam.
- A light tap with every automatic photo, and the photo count rising. The percentage is lime
  from 85%.
- *Done* turns lime only when `quality.ready`: at least 3 RoomPlan walls, 8 photos and 85%
  photo detail. On a desk-only scan RoomPlan may find fewer than 3 walls, so include the walls
  around the table. *Done* works either way.
- Background the app during a scan: the Paused card appears and *Resume* continues.

**Hero shot**

- The level: raising the phone's right edge rotates the line clockwise, so it stays parallel to
  the real horizon. If it moves the wrong way, flip the sign in `HeroShotOverlay.roll`.
- The line turns lime within 1.5°, with a selection tick.
- The shutter shows *Hold still…* for up to about 4 s, then the confirm card with the photo upright.
- In the shared bundle, `photos/photos.json` has exactly one `"hero": true`. Expect
  `"highRes": true`; `false` means the fallback video frame was used. The export strips
  diagnostics, so look at the session's `diagnostics.json` on the phone (Files → Ayna →
  `Houses/ayna/sessions/…`) to see why. `depth/frames.json` should have a frame with almost
  the same `timestamp` and pose. *Retake* removes the flag from the earlier photo and keeps the
  photo.
- *Use it* shows "Saving Mirror 01…", then the map save (up to 6 s, "keep the camera moving
  slowly"), then the review opens by itself.

**Review**

- The preview loads, and *Coloring from photos* runs to the end. That pass writes
  `mesh/room-0-colors.bin`.
- The counters match the manifest, and the hero row shows the photo.
- *Share .zip* → AirDrop to the Mac, then run `cd pipeline && uv run scan2sim build ~/Downloads/"Mirror 01.zip" --out /tmp/mirror`
  (and `scan2sim objects … --photo <hero stem>`).
- The zip holds exactly one `manifest.json`, under `Room/`.
- *Rename mirror*, then *Delete mirror* from the menu and from Home's long-press: the session
  folder under `Documents/Houses/ayna/sessions/` disappears.

**Debug builds:** run `-selftest`. It should still pass, because the house model, export and
coverage scoring are unchanged.

## Known limitations

- *Send to Ayna* is a disabled placeholder. There is no upload, server, voice or AR robot.
- Each mirror still saves an ARKit world map (often 10–40 MB), in the session folder and as a
  copy for its tracking group. It is kept for later relocalization on the same table (an AR
  robot) but costs storage and up to 6 s when finishing. To drop it, skip `saveWorldMap` in
  `CaptureController.finishSession` / `finish(with:)`.
- Only the live overlay uses orange/lime. The colours saved in the PLY, and the full-screen
  preview's *Coverage* style, stay red/amber/green. The pipeline and the self-tests read them,
  so the format stays unchanged.
- If RoomPlan fails to build the room, the bundle has `rooms[0].file = ""` (upstream behaviour),
  which `scan2sim` cannot load. The review still shows the mesh.
- The upstream house, zone and relocalization code, `HouseViewer` and `ScanVersionReview` stay
  compiled for the self-tests, `-autotest-continue` and `-preview-house`. No screen of the app
  reaches them.
