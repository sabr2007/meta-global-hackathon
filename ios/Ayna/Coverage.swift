import RoomPlan
import SwiftUI
import simd

/// What has been photographed well enough: each wall is split into ~0.5 m
/// segments and a segment counts once a steady photo saw it roughly head-on
/// from close enough. Objects count when a photo looked at them.
struct Coverage {
  struct Wall {
    var a: SIMD2<Float> // endpoints on the floor plan (world x, z)
    var b: SIMD2<Float>
    var segments: [Bool]
    var lowConfidence: Bool
    var fraction: Float { segments.isEmpty ? 0 : Float(segments.filter { $0 }.count) / Float(segments.count) }
  }
  struct Box {
    var corners: [SIMD2<Float>]
    var covered: Bool
    var label: String
  }
  struct Gap {
    var a: SIMD2<Float>
    var b: SIMD2<Float>
    var isWindow: Bool
  }

  var walls: [Wall] = []
  var objects: [Box] = []
  var gaps: [Gap] = []
  /// walls from rooms finished earlier in this session, drawn in grey for context
  var previous: [(SIMD2<Float>, SIMD2<Float>)] = []

  var coveredWalls: Int { walls.filter { $0.fraction >= 0.8 }.count }

  static let segmentLength: Float = 0.5

  init() {}

  init(room: CapturedRoom?, previous: [CapturedRoom], photos: [PhotoView]) {
    self.previous = previous.flatMap { $0.walls.map(Self.endpoints) }
    guard let room else { return }
    walls = room.walls.map { wall in
      let (a, b) = Self.endpoints(wall)
      let t = wall.transform
      let center = simd_make_float3(t.columns.3)
      let along = simd_make_float3(t.columns.0)
      let normal = simd_make_float3(t.columns.2)
      let w = wall.dimensions.x
      let n = max(1, Int((w / Self.segmentLength).rounded()))
      let segments = (0..<n).map { i -> Bool in
        let offset = (Float(i) + 0.5) / Float(n) * w - w / 2
        let p = center + along * offset
        return photos.contains { $0.sees(p, surfaceNormal: normal) }
      }
      return Wall(a: a, b: b, segments: segments, lowConfidence: wall.confidence != .high)
    }
    objects = room.objects.map { obj in
      let t = obj.transform
      let c = simd_make_float3(t.columns.3)
      let x = simd_make_float3(t.columns.0) * obj.dimensions.x / 2
      let z = simd_make_float3(t.columns.2) * obj.dimensions.z / 2
      let corners = [c - x - z, c + x - z, c + x + z, c - x + z].map { SIMD2($0.x, $0.z) }
      return Box(corners: corners, covered: photos.contains { $0.sees(c, surfaceNormal: nil) }, label: "\(obj.category)")
    }
    gaps = (room.doors + room.openings).map { Gap(a: Self.endpoints($0).0, b: Self.endpoints($0).1, isWindow: false) }
      + room.windows.map { Gap(a: Self.endpoints($0).0, b: Self.endpoints($0).1, isWindow: true) }
  }

  static func endpoints(_ s: CapturedRoom.Surface) -> (SIMD2<Float>, SIMD2<Float>) {
    let t = s.transform
    let c = simd_make_float3(t.columns.3)
    let x = simd_make_float3(t.columns.0) * s.dimensions.x / 2
    return (SIMD2(c.x - x.x, c.z - x.z), SIMD2(c.x + x.x, c.z + x.z))
  }
}

/// Where a photo was taken from and what it can see
struct PhotoView {
  var position: SIMD3<Float>
  var forward: SIMD3<Float>

  init(transform: simd_float4x4) {
    position = simd_make_float3(transform.columns.3)
    forward = -simd_normalize(simd_make_float3(transform.columns.2))
  }

  /// Inside the central ~60° of the frame, 0.3–4.5 m away, and (for surfaces)
  /// within ~70° of head-on, so the photo is actually useful for modeling it.
  func sees(_ point: SIMD3<Float>, surfaceNormal: SIMD3<Float>?) -> Bool {
    let v = point - position
    let d = simd_length(v)
    guard d > 0.3, d < 4.5 else { return false }
    let dir = v / d
    guard simd_dot(dir, forward) > cos(Float.pi / 6) else { return false }
    if let n = surfaceNormal, abs(simd_dot(dir, simd_normalize(n))) < 0.35 { return false }
    return true
  }
}

/// Round, top-down radar of the scan. With a camera pose it's heading-up and centred on you
/// (live, while scanning): rings, a sweeping beam, the camera's field of view, walls and
/// furniture as dots, lime where a photo covers them and orange where they still need one.
/// Without a pose it's a north-up overview of the room.
struct CoverageMap: View {
  var coverage: Coverage
  var camera: simd_float4x4?
  var photos: [SIMD2<Float>] = []
  /// remaining gaps from the detail pass
  var redSpots: [SIMD2<Float>] = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// one turn of the beam, seconds
  private static let sweep: Double = 3
  /// how far behind the beam dots stay lit
  private static let trail: CGFloat = .pi * 0.6
  /// horizontal field of view of the photos in portrait (the sensor's short side)
  private static let fieldOfView: CGFloat = .pi * 54 / 180
  /// spacing of the dots along walls and furniture, meters
  private static let dotSpacing: Float = 0.12

  private enum Tone: Int, CaseIterable { case covered, needed, opening, previous, gap, photo }

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || camera == nil)) { timeline in
      Canvas { ctx, size in
        let t = timeline.date.timeIntervalSinceReferenceDate
        let beam = CGFloat(t.truncatingRemainder(dividingBy: Self.sweep) / Self.sweep) * 2 * .pi - .pi / 2
        draw(in: &ctx, size: size, beam: camera != nil && !reduceMotion ? beam : nil)
      }
    }
    .clipShape(Circle())
    .overlay(Circle().strokeBorder(AynaTheme.raised, lineWidth: 1))
    .accessibilityElement()
    .accessibilityLabel("Coverage radar")
    .accessibilityValue("\(coverage.coveredWalls) of \(coverage.walls.count) walls photographed")
  }

  private func draw(in ctx: inout GraphicsContext, size: CGSize, beam: CGFloat?) {
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let radius = min(size.width, size.height) / 2
    func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)) }

    ctx.fill(circle(radius), with: .color(AynaTheme.background.opacity(0.84)))
    for k in 1...3 {
      ctx.stroke(circle(radius * CGFloat(k) / 3.2), with: .color(AynaTheme.raised), lineWidth: 1)
    }
    var cross = Path()
    cross.move(to: CGPoint(x: c.x - radius, y: c.y)); cross.addLine(to: CGPoint(x: c.x + radius, y: c.y))
    cross.move(to: CGPoint(x: c.x, y: c.y - radius)); cross.addLine(to: CGPoint(x: c.x, y: c.y + radius))
    ctx.stroke(cross, with: .color(AynaTheme.raised.opacity(0.6)), lineWidth: 0.5)

    if camera != nil {
      // what the camera sees: heading-up, so always straight ahead
      var fov = Path()
      fov.move(to: c)
      fov.addArc(center: c, radius: radius, startAngle: .radians(-.pi / 2 - Self.fieldOfView / 2),
                 endAngle: .radians(-.pi / 2 + Self.fieldOfView / 2), clockwise: false)
      fov.closeSubpath()
      ctx.fill(fov, with: .linearGradient(Gradient(colors: [AynaTheme.neutral.opacity(0.32), AynaTheme.neutral.opacity(0.03)]),
                                          startPoint: c, endPoint: CGPoint(x: c.x, y: c.y - radius)))
    }
    if let beam {
      var sector = Path()
      sector.move(to: c)
      sector.addArc(center: c, radius: radius, startAngle: .radians(beam - Self.trail), endAngle: .radians(beam), clockwise: false)
      sector.closeSubpath()
      let fraction = Self.trail / (2 * .pi)
      ctx.fill(sector, with: .conicGradient(Gradient(stops: [
        .init(color: AynaTheme.neutral.opacity(0), location: 0),
        .init(color: AynaTheme.neutral.opacity(0.2), location: fraction),
        .init(color: AynaTheme.neutral.opacity(0), location: min(1, fraction + 0.001)),
      ]), center: c, angle: .radians(beam - Self.trail)))
      var line = Path()
      line.move(to: c)
      line.addLine(to: CGPoint(x: c.x + cos(beam) * radius, y: c.y + sin(beam) * radius))
      ctx.stroke(line, with: .color(AynaTheme.neutral.opacity(0.75)), lineWidth: 1.2)
    }

    // dots, batched into one path per tone and brightness
    let toScreen = projection(size: size)
    var paths: [Int: Path] = [:]
    func dot(_ p: SIMD2<Float>, _ tone: Tone, size r: CGFloat) {
      let s = toScreen(p)
      var level = 0
      if let beam {
        // lit right after the beam passes, fading over the trail
        let behind = (beam - atan2(s.y - c.y, s.x - c.x)).truncatingRemainder(dividingBy: 2 * .pi)
        let delta = behind < 0 ? behind + 2 * .pi : behind
        level = delta < Self.trail / 3 ? 2 : delta < Self.trail ? 1 : 0
      }
      paths[tone.rawValue * 3 + level, default: Path()].addEllipse(in: CGRect(x: s.x - r, y: s.y - r, width: 2 * r, height: 2 * r))
    }
    func dots(_ a: SIMD2<Float>, _ b: SIMD2<Float>, _ tone: Tone, size r: CGFloat) {
      let n = max(1, Int((simd_distance(a, b) / Self.dotSpacing).rounded()))
      for i in 0...n { dot(a + (b - a) * Float(i) / Float(n), tone, size: r) }
    }
    for p in photos { dot(p, .photo, size: 1) }
    for p in redSpots { dot(p, .gap, size: 0.9) }
    for (a, b) in coverage.previous { dots(a, b, .previous, size: 1.2) }
    for box in coverage.objects {
      for i in box.corners.indices { dots(box.corners[i], box.corners[(i + 1) % box.corners.count], box.covered ? .covered : .needed, size: 1.5) }
    }
    for wall in coverage.walls {
      let n = wall.segments.count
      for (i, covered) in wall.segments.enumerated() {
        let a = wall.a + (wall.b - wall.a) * Float(i) / Float(n)
        let b = wall.a + (wall.b - wall.a) * Float(i + 1) / Float(n)
        dots(a, b, covered ? .covered : .needed, size: wall.lowConfidence ? 1.4 : 1.8)
      }
    }
    for gap in coverage.gaps { dots(gap.a, gap.b, .opening, size: 1.6) }
    for (key, path) in paths {
      guard let tone = Tone(rawValue: key / 3) else { continue }
      let base: Color = switch tone {
      case .covered: AynaTheme.lime
      case .needed, .gap: AynaTheme.orange
      case .opening: AynaTheme.neutral
      case .previous: AynaTheme.reflection
      case .photo: AynaTheme.text
      }
      let dim: Double = tone == .gap ? 0.45 : tone == .photo ? 0.35 : 0.72
      ctx.fill(path, with: .color(base.opacity([dim, (dim + 1) / 2, 1][key % 3])))
    }

    if camera != nil {
      // you
      ctx.fill(circle(4.5), with: .color(AynaTheme.text))
      ctx.stroke(circle(4.5), with: .color(AynaTheme.background), lineWidth: 1.5)
    }
  }

  /// world (x, z) → screen, fitted to everything drawn
  private func projection(size: CGSize) -> (SIMD2<Float>) -> CGPoint {
    let all = coverage.walls.flatMap { [$0.a, $0.b] } + coverage.previous.flatMap { [$0.0, $0.1] } + coverage.objects.flatMap(\.corners)
    if let camera {
      let pos = SIMD2(camera.columns.3.x, camera.columns.3.z)
      let f = -SIMD2(camera.columns.2.x, camera.columns.2.z)
      let heading = atan2(f.x, -f.y) // clockwise from map-up
      let beta = -heading
      let radius = max(2.5, all.map { simd_distance($0, pos) }.max() ?? 2.5) + 0.3
      let scale = Float(min(size.width, size.height)) / 2 / radius
      return { p in
        let d = p - pos
        let x = cos(beta) * d.x - sin(beta) * d.y
        let y = sin(beta) * d.x + cos(beta) * d.y
        return CGPoint(x: CGFloat(x * scale) + size.width / 2, y: CGFloat(y * scale) + size.height / 2)
      }
    }
    let lo = all.reduce(SIMD2<Float>(repeating: .infinity)) { simd_min($0, $1) }
    let hi = all.reduce(SIMD2<Float>(repeating: -.infinity)) { simd_max($0, $1) }
    // fit the room's diagonal inside the circle
    let span = all.isEmpty ? Float(1) : max(1, simd_length(hi - lo))
    let scale = Float(min(size.width, size.height)) / (span + 0.6)
    let mid = all.isEmpty ? .zero : (lo + hi) / 2
    return { p in
      CGPoint(x: CGFloat((p.x - mid.x) * scale) + size.width / 2, y: CGFloat((p.y - mid.y) * scale) + size.height / 2)
    }
  }
}
