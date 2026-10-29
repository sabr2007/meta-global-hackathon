# Ayna for iPhone

*Show your robot the after.*

The scanner is the first step of Ayna. You walk around a table with a LiDAR iPhone. The app
records the table and its room, then asks for one **hero shot**: the "before" photo. It sends
everything to Ayna, or shares it, as a `house-capture/5` bundle. The pipeline (`../pipeline`, `scan2sim`) turns that
bundle into a MuJoCo twin of the table. Muse Image draws the "after" from the hero shot, a
robot arm works towards that state in simulation, and SAM 3.1 checks the result against the
picture.

The capture engine comes from the open-source **3D Model Anything** app by Wes Bos (MIT, see
[`LICENSE-3d-model-anything`](LICENSE-3d-model-anything)), imported unchanged in the first
commit of this folder. The flow, the design, the hero shot, the review and Send to Ayna are new. See
[`../NEW_WORK.md`](../NEW_WORK.md) for the split.

## Requirements

- An iPhone with LiDAR (iPhone 12 Pro or later; the target device is an iPhone 13 Pro) on iOS 17 or later.
  Other devices can open and share mirrors but cannot scan.
- Xcode 27 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

## Build

The Xcode project is generated from `project.yml` and is not committed.

```sh
cd ios && xcodegen generate
```

Then open `Ayna.xcodeproj`, pick your team under *Signing & Capabilities* and run on the phone.
You can also build from the command line:

```sh
xcodebuild -project Ayna.xcodeproj -scheme Ayna -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your team id> build
```

```sh
xcrun devicectl device install app --device <device id> build/Build/Products/Release-iphoneos/Ayna.app
```

`DEVELOPMENT_TEAM` is deliberately not in `project.yml`. Use a Release build for real scans,
because Debug turns off Swift optimizations. Run `xcodegen generate` again after adding or
renaming files. Known risks for the first build are listed in [`BUILD_NOTES.md`](BUILD_NOTES.md).

## The flow

**Home → New scan → Scan → Hero shot → Review → Send to Ayna (or Share .zip)**

One scan is one **mirror**. Every mirror is a new capture session with a single room, and it
always starts in a fresh ARKit world. The app never relocalizes against an earlier scan.

1. **Home.** The Ayna logo, the lime *New scan* card and your mirrors. Each mirror shows a clay
   thumbnail of its mesh, its date and its photo detail. Long-press a mirror to delete it.
2. **Scan.** The camera starts right away. The LiDAR mesh is drawn over the camera image:
   - Orange triangles still need photos; lime triangles are covered. A triangle counts as
     covered when its score reaches `CoverageEngine.goodScore`. Newly covered triangles flash
     briefly.
   - Photos are taken automatically. The app keeps sharp frames from views that add coverage,
     and gives a light tap for each one. The shutter adds a close-up.
   - The top shows *photo detail* in large dot-matrix digits, lime from 85%, and the photo count.
   - The middle shows RoomPlan's coaching ("Move closer to the wall", "Slow down", …) and the
     state of the scan.
   - The bottom holds a round radar, the shutter and *Done*. The radar is heading-up: you are in
     the centre with the camera's field of view, and walls and furniture are dots, lime when
     photographed and orange when not. *Done* turns lime when the scan reads complete: at least
     3 walls, 8 photos and 85% photo detail. It never blocks saving.
3. **Hero shot.** After *Done*, the room is still open in the same ARSession, so the hero photo's
   pose lands in the scan's own world frame. The screen asks you to frame the whole work surface
   and shows a horizon level that turns lime within 1.5°. The shutter waits up to a second for a
   steady camera. It then takes a full-resolution still through ARKit's
   `captureHighResolutionFrame` (the same path as the high-resolution auto photos). It keeps the
   still only if it is larger than the video frame and shows the same view (within 20 cm and
   12°); otherwise it uses the video frame. A depth frame is recorded at the moment of the shot.
   You can *Retake* or *Use it*. *Skip* saves the scan without a hero shot, and *Back* returns to
   scanning.
4. **Review.** The mirror opens by itself once it is saved. If saving reported a problem, the scan
   screen first shows it on a *Saved* card. The review shows the name (rename from the menu) and
   the 3D preview, coloured from the photos. It also shows counters for photos, depth
   frames and coverage, and the hero shot.
5. **Send to Ayna.** Uploads this mirror to the Ayna server, which builds its twin; see below.
   **Share .zip** exports the same bundle through the share sheet (AirDrop, Files, …).

Let the review finish *Coloring from photos* before you send or share. That pass writes
`mesh/room-0-colors.bin`, and the pipeline uses it for the mesh colours.

## Send to Ayna

The card on the review goes **idle → zipping → uploading NN% → queued** ("Ayna is building your
twin — open it on the web"), or **failed** with the server's message and *Retry*.

- **Pairing, once per iPhone.** The web's *Mirrors* page shows a 6-character code that works for
  10 minutes. The first *Send to Ayna* opens a sheet for it (*Pair and send*). The token goes to
  the Keychain (service `com.sabyrzhan.ayna.server`, one item per server, this device only). The
  account chip on the card and *Pairing with Ayna* in the mirror's menu open the same sheet;
  its menu edits the server and unpairs.
- **Server.** `https://ayna-scan.vercel.app` by default (`AynaServer.defaultBaseURL`, the only
  place it is written). The sheet can change it (https only); it is kept in `UserDefaults`.
- **Upload.** The zip is the *Share .zip* export (`ScanBundle.zippedRoom`). It is moved to
  `Application Support/Uploads` and uploaded by a background `URLSession`, so it carries on
  while the app is in the background or was closed by iOS. Closing Ayna from the app switcher
  stops it. Each mirror's last confirmed send is remembered, and a confirmation the server
  missed is retried at the next launch.
- **Any 401** removes the token and asks to pair again.

The calls (`AynaServer.swift`):

```
POST {base}/api/devices/pair               {code, deviceName}            → {token, user: {email}}
POST {base}/api/uploads            Bearer  {name, sizeBytes, capturedAt} → {scanId, uploadUrl, method, headers}
<method> uploadUrl                         the .zip with exactly those headers, no Bearer
POST {base}/api/uploads/{scanId}/complete  Bearer                        → {status: "queued"}
```

Errors are 4xx/5xx with `{error: "message"}`; storage errors show their XML `<Message>`.

## What a mirror contains

The format is unchanged `house-capture/5`, the one `pipeline/src/scan2sim/capture.py` reads.
The only addition is an optional `hero` field on one photo. The shared zip holds exactly one
`manifest.json`:

```
Mirror 01.zip
  Room/
    manifest.json          "format": "house-capture/5", rooms[1] (file, mesh.file), photos, depthFrames
    rooms/room-0.json      RoomPlan CapturedRoom; room-0.usdz, room-0-mesh.usdz, room-0-data.json
    mesh/room-0.ply        LiDAR mesh in ARKit world space; room-0-colors.bin once the review coloured it
    photos/photos.json     [{ file, room, timestamp, width, height, transform, intrinsics, tracking,
                              manual, exposure, blurPixels, pass, highRes, camera, hero? }]
    photos/NNNN.jpg        sensor orientation (EXIF 6), up to 3024 px on the long edge
    depth/frames.json      [{ file, confidence, rgb, rgbIntrinsics, camera, room, timestamp,
                              width, height, transform, intrinsics }]
    depth/NNNNN.f16z|.conf|.jpg
```

- `transform` is camera-to-world, column-major 4×4. The camera looks down −Z, and the world is
  ARKit's: metres, +Y up. `intrinsics` is a column-major 3×3 that matches the JPEG pixels.
- **Hero shot**: exactly one photo has `"hero": true`. It uses the same conventions as every
  other photo and is usually a full-resolution still (`"highRes": true`). The depth frame
  closest in time was recorded during the shot, from the same view. Until the pipeline reads the flag, pass the
  hero's file stem by hand, for example `scan2sim objects "Mirror 01.zip" --photo 0042`.

On the phone, mirrors live in `Documents/Houses/ayna/`: `house.json` plus one
`sessions/<date>/` folder per mirror. The folder is also visible in the Files app. A scan killed
before its room was saved cannot become a mirror, so Home deletes its folder the next time it opens. The upstream
house / zone / session model is still underneath: Ayna keeps one implicit house and gives each
scan its own tracking group. The session's ARKit world map is still saved, which keeps the
option of relocalizing on the same table later, for example to show the robot in AR.

## Design

`Ayna/AynaDesign.swift` holds the design system:

- **Colours.** The app is dark everywhere: background `#1B1B1C`, surfaces `#252528` and `#3A3A3E`,
  neutral grey `#B5B5BA`, text white, secondary text `#9A9AA0`. **Lime `#B8FF5E`** means done,
  covered or verified; text on lime is `#173404`. **Orange `#EE7F35`** means something needs attention.
- **Type.** [Michroma](https://fonts.google.com/specimen/Michroma) is the wide geometric face for
  the logo and titles. [Doto](https://fonts.google.com/specimen/Doto) is the dot-matrix face, like
  LiDAR points, for numbers and counters. SF Pro is used for body text.
- **Logo.** "AYNA" in Michroma over the same word in Doto, flipped vertically in `#55555A`: the
  thing and its mirror of points. Each dotted letter is centred under its solid one.
- **Motif.** Overlapping light-grey circles with a thin `#1B1B1C` outline, with one orange accent.
  Cards use 20–24 pt corners, buttons are pills, and the main *New scan* card is lime.
- **Icon.** A light-grey Michroma "A" over its dotted reflection on graphite.

The fonts in `Ayna/Fonts` come from [google/fonts](https://github.com/google/fonts) (`ofl/michroma`,
`ofl/doto`) under the SIL Open Font License; their licenses are `OFL-Michroma.txt` and
`OFL-Doto.txt`. Doto is a variable font, so the app ships two static instances with round dots
(`ROND=100`) at `wght=700` and `wght=900`. Their PostScript names are `Doto-Bold` and
`Doto-Black`. The scripts that make the instances and the icon live in `tools/` (Python;
`pip install fonttools pillow`):

```sh
python tools/make_doto_static.py "Doto[ROND,wght].ttf" Ayna/Fonts
```

```sh
python tools/make_app_icon.py
```

## Code map

| File | What |
|---|---|
| `AynaApp.swift` | app entry, app delegate for background uploads, share sheet, developer launch modes |
| `HomeScreen.swift` | Home: logo, New scan card, mirror list |
| `MirrorLibrary.swift` | the implicit house, mirrors, names, start/delete/rename |
| `CaptureScreen.swift` | the scan screen and its auto flow (start, finish, close) |
| `HeroShotView.swift` | hero shot framing, level, confirm |
| `MirrorScreen.swift` | review, 3D preview, Send to Ayna, Share .zip |
| `SendToAyna.swift` | the Send to Ayna card and the pairing sheet |
| `AynaUploader.swift` | pairing state, per-mirror send state, the background upload session |
| `AynaServer.swift` | server address, Keychain pairing, the JSON calls and their errors |
| `AynaDesign.swift` | colours, fonts, logo, circles, buttons, cards, thumbnails |
| `Coverage.swift` | wall coverage model and the round radar (`CoverageMap`) |
| `CaptureController.swift` | upstream capture session; Ayna adds the hero shot and the auto-photo haptic |
| `CoverageEngine.swift`, `ScanView.swift` | upstream coverage scoring and live mesh; Ayna adds the lime flash, orange/lime colours and a forced depth frame |
| everything else | upstream engine, preview, bundle format, diagnostics and self-tests |

## Developer launch arguments (Debug builds)

These are kept from upstream:

- `-selftest` checks storage, bundles, export and coverage scoring without the camera, then
  exits 0 or 1. It runs in the simulator.
- `-autotest` runs a hands-free scan in a new "Autotest" house, then exits. `-autotest-continue`
  relocalizes in that house first.
- `-diag` probes RoomPlan together with ARKit's mesh and depth on one session.
- `-preview-house <folder>` (with `-preview-session n`, `-preview-style …`) opens the 3D preview directly.

Read the logs with
`xcrun devicectl device process launch --console --device <id> com.sabyrzhan.ayna -selftest`.

## Privacy

Ayna has no analytics or tracking. It goes online only to pair with Ayna and for *Send to
Ayna*, which uploads the one mirror you choose; otherwise scans stay on the phone until you
share a zip. Photos and geometry of a real space are private data, so this repository never
contains scans, photos or keys.
