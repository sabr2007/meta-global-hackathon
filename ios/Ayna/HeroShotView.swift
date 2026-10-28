import SwiftUI
import simd

/// The hero shot, after Done and before the room is finished (same ARSession, same world as the
/// scan): frame the whole work surface, hold the phone level, take one full-resolution photo.
/// It is saved as an ordinary posed photo with `"hero": true` and becomes the "before" image.
struct HeroShotOverlay: View {
  @ObservedObject var controller: CaptureController

  /// within this many degrees of the horizon the level reads lime
  static let levelTolerance: Double = 1.5

  var body: some View {
    let roll = Self.roll(controller.cameraPose)
    let level = roll.map { abs($0) * 180 / .pi < Self.levelTolerance } ?? false
    let reviewing = controller.heroPhotoURL != nil
    ZStack {
      if !reviewing {
        FramingGuide(level: level).allowsHitTesting(false)
        if let roll { LevelIndicator(roll: roll, level: level).allowsHitTesting(false) }
      }
      VStack(spacing: 12) {
        header
        Spacer(minLength: 0)
        if let url = controller.heroPhotoURL {
          confirmCard(url)
        } else {
          status(level: level)
          controls(level: level)
        }
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
    .onChange(of: level) { _, now in
      if now && !reviewing { UISelectionFeedbackGenerator().selectionChanged() }
    }
  }

  /// Tilt of the picture's horizontal axis against the horizon, radians (+ = right edge up).
  /// In portrait the screen's right edge is the ARKit camera's +Y axis.
  static func roll(_ pose: simd_float4x4?) -> Double? {
    guard let pose else { return nil }
    let right = simd_make_float3(pose.columns.1)
    let length = simd_length(right)
    guard length > 1e-4 else { return nil }
    return Double(asin(max(-1, min(1, right.y / length))))
  }

  // MARK: pieces

  private var header: some View {
    VStack(spacing: 6) {
      AynaEyebrow(text: "Hero shot", color: AynaTheme.lime)
      Text("Frame the whole work surface")
        .font(.michroma(18, relativeTo: .title3))
        .multilineTextAlignment(.center)
      Text("Step back until the entire table is in view, about 45° from above, and hold the phone level. This photo is the \"before\" Ayna turns into the \"after\".")
        .font(.footnote)
        .foregroundStyle(AynaTheme.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .frame(maxWidth: 500)
    .background(AynaTheme.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: AynaTheme.cardRadius, style: .continuous))
    .padding(.top, 6)
  }

  @ViewBuilder private func status(level: Bool) -> some View {
    if controller.paused {
      VStack(alignment: .leading, spacing: 10) {
        pill("Paused. Resume to take the hero shot.", dot: AynaTheme.orange)
        Button(action: controller.resume) { Label("Resume", systemImage: "play.fill") }
          .buttonStyle(AynaButtonStyle(kind: .lime))
      }
      .frame(maxWidth: 500)
    } else if controller.heroInFlight {
      HStack(spacing: 10) {
        ProgressView().tint(AynaTheme.lime)
        Text("Hold still…").font(.footnote.weight(.medium))
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(AynaTheme.surface.opacity(0.88), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    } else if let issue = controller.trackingIssue {
      pill(issue.message, dot: AynaTheme.orange)
    } else {
      if let notice = controller.notice { pill(notice, dot: AynaTheme.orange) }
      pill(level ? "Level. Take the hero shot." : "Tilt until the line turns lime.", dot: level ? AynaTheme.lime : AynaTheme.orange)
    }
  }

  private func controls(level: Bool) -> some View {
    HStack {
      Button("Back", action: controller.cancelHeroShot)
        .font(.subheadline.weight(.semibold))
        .frame(width: 96, height: 44)
        .background(AynaTheme.surface.opacity(0.88), in: Capsule())
        .accessibilityHint("Returns to scanning")
      Spacer()
      shutter(level: level)
      Spacer()
      Button("Skip", action: controller.skipHeroShot)
        .font(.subheadline.weight(.semibold))
        .frame(width: 96, height: 44)
        .background(AynaTheme.surface.opacity(0.88), in: Capsule())
        .accessibilityHint("Saves the scan without a hero shot")
    }
    .buttonStyle(.plain)
    .foregroundStyle(AynaTheme.text)
    .disabled(controller.heroInFlight)
  }

  private func shutter(level: Bool) -> some View {
    Button {
      UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
      controller.takeHeroShot()
    } label: {
      ZStack {
        Circle().fill(level ? AynaTheme.lime : AynaTheme.neutral)
        Circle().strokeBorder(AynaTheme.background, lineWidth: 2).padding(6)
        if controller.heroInFlight {
          ProgressView().tint(AynaTheme.background)
        } else {
          Image(systemName: "camera.aperture")
            .font(.title2.weight(.semibold))
            .foregroundStyle(level ? AynaTheme.onLime : AynaTheme.background)
        }
      }
      .frame(width: 84, height: 84)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(!controller.canTakeHeroShot)
    .opacity(controller.canTakeHeroShot || controller.heroInFlight ? 1 : 0.45)
    .accessibilityLabel("Take the hero shot")
  }

  private func confirmCard(_ url: URL) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.lime)
        Text("Hero shot saved").font(.headline)
      }
      UprightPhoto(url: url)
        .frame(maxWidth: .infinity)
        .frame(height: 240)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      Text("Is the whole work surface in the picture, and sharp?")
        .font(.footnote)
        .foregroundStyle(AynaTheme.secondary)
      HStack(spacing: 10) {
        Button("Retake", action: controller.retakeHeroShot)
          .buttonStyle(AynaButtonStyle(kind: .raised))
        Button(action: controller.useHeroShot) { Label("Use it", systemImage: "checkmark") }
          .buttonStyle(AynaButtonStyle(kind: .lime))
      }
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.96))
  }

  private func pill(_ text: String, dot: Color) -> some View {
    HStack(spacing: 8) {
      StatusDot(color: dot)
      Text(text)
        .font(.footnote.weight(.medium))
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(AynaTheme.surface.opacity(0.88), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// Corner brackets: keep the work surface inside, with a margin
private struct FramingGuide: View {
  var level: Bool
  var body: some View {
    GeometryReader { geo in
      let inset: CGFloat = 22
      let r = CGRect(x: inset, y: geo.size.height * 0.24, width: geo.size.width - 2 * inset, height: geo.size.height * 0.44)
      Path { p in
        let d: CGFloat = 34
        for (x, y, sx, sy) in [(r.minX, r.minY, 1.0, 1.0), (r.maxX, r.minY, -1.0, 1.0), (r.minX, r.maxY, 1.0, -1.0), (r.maxX, r.maxY, -1.0, -1.0)] {
          p.move(to: CGPoint(x: x, y: y + sy * d))
          p.addLine(to: CGPoint(x: x, y: y))
          p.addLine(to: CGPoint(x: x + sx * d, y: y))
        }
      }
      .stroke(level ? AynaTheme.lime : AynaTheme.neutral, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }
}

/// The horizon as the camera sees it, against fixed level marks; lime when level
private struct LevelIndicator: View {
  let roll: Double
  let level: Bool
  var body: some View {
    GeometryReader { geo in
      let c = CGPoint(x: geo.size.width / 2, y: geo.size.height * 0.46)
      let w = geo.size.width * 0.56
      let tint = level ? AynaTheme.lime : AynaTheme.orange
      ZStack {
        Path { p in
          p.move(to: CGPoint(x: c.x - w / 2 - 30, y: c.y)); p.addLine(to: CGPoint(x: c.x - w / 2 - 10, y: c.y))
          p.move(to: CGPoint(x: c.x + w / 2 + 10, y: c.y)); p.addLine(to: CGPoint(x: c.x + w / 2 + 30, y: c.y))
        }
        .stroke(AynaTheme.neutral.opacity(0.85), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        ZStack {
          Capsule().fill(tint).frame(width: w, height: 2.5)
          Circle().strokeBorder(tint, lineWidth: 2).frame(width: 22, height: 22)
        }
        .rotationEffect(.radians(roll))
        .position(c)
        .animation(.easeOut(duration: 0.12), value: roll)
        Text(String(format: "%.1f°", abs(roll) * 180 / .pi))
          .font(.doto(16, black: false, fixed: true))
          .foregroundStyle(tint)
          .position(x: c.x, y: c.y + 30)
      }
    }
    .ignoresSafeArea()
    .accessibilityElement()
    .accessibilityLabel(level ? "Level" : "Tilted \(Int((abs(roll) * 180 / .pi).rounded())) degrees")
  }
}
