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

/// Top-down coverage map. With a camera pose it's heading-up and centered on
/// you (live, while scanning); without one it's a north-up overview of the room.
struct CoverageMap: View {
  var coverage: Coverage
  var camera: simd_float4x4?
  var photos: [SIMD2<Float>] = []
  /// remaining gaps from the detail pass
  var redSpots: [SIMD2<Float>] = []

  var body: some View {
    Canvas { ctx, size in
      let (toScreen, _) = projection(size: size)
      let line = { (a: SIMD2<Float>, b: SIMD2<Float>) -> Path in
        var p = Path()
        p.move(to: toScreen(a))
        p.addLine(to: toScreen(b))
        return p
      }

      for (a, b) in coverage.previous {
        ctx.stroke(line(a, b), with: .color(.gray.opacity(0.6)), lineWidth: 3)
      }
      for box in coverage.objects {
        var p = Path()
        p.addLines(box.corners.map(toScreen))
        p.closeSubpath()
        ctx.fill(p, with: .color((box.covered ? Color.green : .orange).opacity(0.25)))
        ctx.stroke(p, with: .color(box.covered ? .green : .orange), lineWidth: 1)
      }
      for wall in coverage.walls {
        let n = wall.segments.count
        for (i, covered) in wall.segments.enumerated() {
          let a = wall.a + (wall.b - wall.a) * Float(i) / Float(n)
          let b = wall.a + (wall.b - wall.a) * Float(i + 1) / Float(n)
          let style = StrokeStyle(lineWidth: 5, lineCap: .butt, dash: wall.lowConfidence ? [4, 3] : [])
          ctx.stroke(line(a, b), with: .color(covered ? .green : .red), style: style)
        }
      }
      for gap in coverage.gaps {
        ctx.stroke(line(gap.a, gap.b), with: .color(gap.isWindow ? .cyan : .blue), lineWidth: 8)
      }
      for p in redSpots {
        let s = toScreen(p)
        ctx.fill(Path(ellipseIn: CGRect(x: s.x - 2, y: s.y - 2, width: 4, height: 4)), with: .color(.red.opacity(0.85)))
      }
      for p in photos {
        let s = toScreen(p)
        ctx.fill(Path(ellipseIn: CGRect(x: s.x - 1.5, y: s.y - 1.5, width: 3, height: 3)), with: .color(.pink.opacity(0.8)))
      }
      if camera != nil {
        // you, pointing up
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        var arrow = Path()
        arrow.move(to: CGPoint(x: c.x, y: c.y - 9))
        arrow.addLine(to: CGPoint(x: c.x + 6, y: c.y + 6))
        arrow.addLine(to: CGPoint(x: c.x, y: c.y + 2))
        arrow.addLine(to: CGPoint(x: c.x - 6, y: c.y + 6))
        arrow.closeSubpath()
        ctx.fill(arrow, with: .color(.white))
      }
    }
  }

  /// world (x, z) → screen, fitted to everything drawn
  private func projection(size: CGSize) -> ((SIMD2<Float>) -> CGPoint, Float) {
    let all = coverage.walls.flatMap { [$0.a, $0.b] } + coverage.previous.flatMap { [$0.0, $0.1] }
    if let camera {
      let pos = SIMD2(camera.columns.3.x, camera.columns.3.z)
      let f = -SIMD2(camera.columns.2.x, camera.columns.2.z)
      let heading = atan2(f.x, -f.y) // clockwise from map-up
      let beta = -heading
      let radius = max(2.5, all.map { simd_distance($0, pos) }.max() ?? 2.5) + 0.3
      let scale = Float(min(size.width, size.height)) / 2 / radius
      return ({ p in
        let d = p - pos
        let x = cos(beta) * d.x - sin(beta) * d.y
        let y = sin(beta) * d.x + cos(beta) * d.y
        return CGPoint(x: CGFloat(x * scale) + size.width / 2, y: CGFloat(y * scale) + size.height / 2)
      }, scale)
    }
    let lo = all.reduce(SIMD2<Float>(repeating: .infinity)) { simd_min($0, $1) }
    let hi = all.reduce(SIMD2<Float>(repeating: -.infinity)) { simd_max($0, $1) }
    let span = all.isEmpty ? SIMD2<Float>(1, 1) : simd_max(hi - lo, SIMD2(1, 1))
    let scale = min(Float(size.width) / (span.x + 0.6), Float(size.height) / (span.y + 0.6))
    let mid = all.isEmpty ? .zero : (lo + hi) / 2
    return ({ p in
      CGPoint(x: CGFloat((p.x - mid.x) * scale) + size.width / 2, y: CGFloat((p.y - mid.y) * scale) + size.height / 2)
    }, scale)
  }
}
