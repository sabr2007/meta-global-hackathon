import ARKit
import Foundation
import ImageIO
import simd

// Everything "Continue in <zone>" needs besides the ARSession itself:
// - `ZoneReference`: the zone's saved room meshes, as a decimated ghost to draw and as a voxel
//   index to check the relocalized world against
// - `LiveMeshSampler`: a few thousand live LiDAR mesh points in front of the camera
// - `PriorPhotos`: the zone's earlier photos (with occlusion depth) for the coverage engine
// - `WorldMapFile`: ARWorldMap archiving

// MARK: - World map files

enum WorldMapFile {
  static let sessionFile = "worldmap.arworldmap"

  static func zoneRelativePath(_ zone: String) -> String { "zones/\(zone)/worldmap.arworldmap" }

  /// Call off the main thread (maps are 5–60 MB)
  static func load(_ url: URL) throws -> ARWorldMap {
    let data = try Data(contentsOf: url)
    guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
      throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: url.path])
    }
    return map
  }

  /// Archive once, write to every destination atomically. Returns the size in bytes. Off main.
  static func write(_ map: ARWorldMap, to urls: [URL]) throws -> Int {
    let data = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
    for url in urls {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
    }
    return data.count
  }

  static func describe(_ s: ARFrame.WorldMappingStatus) -> String {
    switch s {
    case .notAvailable: "notAvailable"
    case .limited: "limited"
    case .extending: "extending"
    case .mapped: "mapped"
    @unknown default: "unknown"
    }
  }
}

// MARK: - Saved geometry of a zone

/// The zone's earlier room meshes (`mesh/room-*.ply` of every placed session in the zone,
/// moved into the zone frame by each session's `toZone`), in two forms:
/// - `ghost`: vertex-clustered (~5 cm) triangle mesh to draw as a green overlay
/// - `index`: 4 cm voxels (centroid + normal) to measure live-mesh distances against
final class ZoneReference: @unchecked Sendable { // immutable after load
  struct Ghost {
    var positions: [SIMD3<Float>]
    var normals: [SIMD3<Float>]
    var indices: [UInt32]
    var triangleCount: Int { indices.count / 3 }
  }

  let ghost: Ghost?
  let index: SurfaceIndex
  let sourceVertices: Int
  let files: [String]
  let errors: [String]

  var isEmpty: Bool { index.points.isEmpty }

  init(ghost: Ghost?, index: SurfaceIndex, sourceVertices: Int, files: [String], errors: [String]) {
    self.ghost = ghost
    self.index = index
    self.sourceVertices = sourceVertices
    self.files = files
    self.errors = errors
  }

  /// Load a zone's saved meshes. Slow (seconds for millions of vertices): call off main.
  ///
  /// Within a session the coverage engine keeps every mesh anchor it ever saw, so each room's
  /// PLY contains all the rooms before it: the newest non-empty one per session is the whole
  /// session. (`allFiles` reads every PLY instead, e.g. for bundles written differently.)
  static func load(house: HouseProject, zone: String, excludingSession: String?, allFiles: Bool = false) -> ZoneReference {
    var inputs: [(url: URL, toZone: simd_float4x4, name: String)] = []
    for s in house.placedSessionsInZone(zone) where s.id != excludingSession {
      let bundle = house.bundle(for: s)
      let meshDir = bundle.file("mesh")
      let names = ((try? FileManager.default.contentsOfDirectory(atPath: meshDir.path)) ?? [])
        .filter { $0.hasPrefix("room-") && $0.hasSuffix(".ply") }
        .sorted { roomNumber($0) > roomNumber($1) }
      let toZone = simd_float4x4(columnMajor: s.alignment.toZone)
      if allFiles {
        for n in names { inputs.append((meshDir.appendingPathComponent(n), toZone, "\(s.id)/\(n)")) }
      } else if let newest = names.first(where: { PLYFile.vertexCount(meshDir.appendingPathComponent($0)) > 0 }) {
        inputs.append((meshDir.appendingPathComponent(newest), toZone, "\(s.id)/\(newest)"))
      }
    }
    return build(inputs)
  }

  private static func roomNumber(_ name: String) -> Int {
    Int(name.dropFirst("room-".count).prefix { $0.isNumber }) ?? -1
  }

  static func build(_ inputs: [(url: URL, toZone: simd_float4x4, name: String)]) -> ZoneReference {
    var files: [PLYFile] = []
    var errors: [String] = []
    var used: [String] = []
    var transforms: [simd_float4x4] = []
    for input in inputs {
      do {
        files.append(try PLYFile(url: input.url))
        transforms.append(input.toZone)
        used.append(input.name)
      } catch {
        errors.append("\(input.name): \(error.localizedDescription)")
      }
    }
    let total = files.reduce(0) { $0 + $1.vertexCount }
    // coarser clusters for bigger zones so the overlay stays a few hundred k triangles
    let cell: Float = total <= 1_500_000 ? 0.05 : total <= 4_000_000 ? 0.07 : 0.09
    var ghostBuilder = GhostBuilder(cell: cell, maxTriangles: 600_000)
    var indexBuilder = SurfaceIndex.Builder()
    for (file, m) in zip(files, transforms) {
      let rot = simd_float3x3(simd_make_float3(m.columns.0), simd_make_float3(m.columns.1), simd_make_float3(m.columns.2))
      var clusterOf = [Int32](repeating: -1, count: file.vertexCount)
      var world = [SIMD3<Float>](repeating: .zero, count: file.vertexCount)
      file.forEachVertex { i, p, n in
        let w = simd_make_float3(m * SIMD4(p, 1))
        let wn = n.map { simd_normalize(rot * $0) } ?? .zero
        world[i] = w
        clusterOf[i] = ghostBuilder.addVertex(w, wn)
        indexBuilder.add(w, wn)
      }
      file.forEachFace { a, b, c in
        guard a < world.count, b < world.count, c < world.count else { return }
        // ARKit bridges unseen gaps with long slivers: don't draw them
        let pa = world[a], pb = world[b], pc = world[c]
        if simd_distance(pa, pb) > 0.35 || simd_distance(pb, pc) > 0.35 || simd_distance(pc, pa) > 0.35 { return }
        ghostBuilder.addTriangle(clusterOf[a], clusterOf[b], clusterOf[c])
      }
    }
    let ghost = ghostBuilder.finish(inset: 0.015)
    return ZoneReference(ghost: ghost.triangleCount > 0 ? ghost : nil, index: indexBuilder.finish(), sourceVertices: total, files: used, errors: errors)
  }

  // MARK: alignment check

  /// A live mesh point and its normal (session world)
  struct LivePoint {
    var p: SIMD3<Float>
    var n: SIMD3<Float>
  }

  /// How well the live mesh sits on the saved one. Floors, ceilings and a single flat wall
  /// can't see a shift along themselves (a 36 cm shift or a 9° turn still leaves most points
  /// "on" some saved surface), so walls are judged on their own, per direction: at least two
  /// non-parallel wall directions (a corner, furniture, a door frame) have to line up.
  struct Check: Equatable {
    /// live points given
    var sampled = 0
    /// near (≤ ~40 cm) saved surfaces: where old and new scans should overlap
    var known = 0
    /// of the known ones, within 8 cm of a saved surface facing the same way
    var matched = 0
    /// the same for vertical surfaces only (walls, furniture sides, door frames)
    var wallKnown = 0
    var wallMatched = 0
    /// floors / ceilings / table tops
    var flatKnown = 0
    var flatMatched = 0
    /// wall directions (folded to 0–180°, 22.5° bins) with ≥ 30 known points and ≥ 50% matched,
    /// and the widest angle between two of them (degrees)
    var directions = 0
    var spreadDegrees: Float = 0
    /// median point-to-plane distance of the matched wall points (all matched points if there are no walls)
    var median: Float?

    var inlierFraction: Float { known > 0 ? Float(matched) / Float(known) : 0 }
    var wallFraction: Float { wallKnown > 0 ? Float(wallMatched) / Float(wallKnown) : 0 }
    var flatFraction: Float { flatKnown > 0 ? Float(flatMatched) / Float(flatKnown) : 0 }

    /// walls line up, but only one direction is in view
    var needsCorner: Bool { wallKnown >= 100 && wallFraction >= 0.6 && spreadDegrees < 45 }

    var isGood: Bool {
      wallKnown >= 100 && wallMatched >= 80 && wallFraction >= 0.6 && spreadDegrees >= 45
        && (median ?? 1) < 0.04 && (flatKnown < 40 || flatFraction >= 0.5)
    }

    /// Plenty of overlap, but it doesn't line up: a false relocalization (or the world reset)
    var isMismatch: Bool {
      (wallKnown >= 200 && wallFraction < 0.25) || (known >= 300 && inlierFraction < 0.2)
    }
  }

  /// Distances from live points (current session world = zone frame if relocalized) to the saved surfaces
  func check(_ points: [LivePoint]) -> Check {
    var c = Check(sampled: points.count)
    var wallDistances: [Float] = []
    var allDistances: [Float] = []
    var binKnown = [Int](repeating: 0, count: 8)
    var binMatched = [Int](repeating: 0, count: 8)
    for lp in points {
      guard index.isNearSurface(lp.p, normal: lp.n) else { continue }
      c.known += 1
      let vertical = abs(lp.n.y) < 0.5
      let flat = abs(lp.n.y) > 0.8
      var bin = -1
      if vertical {
        c.wallKnown += 1
        var a = atan2(lp.n.z, lp.n.x) // fold: parallel and opposite walls constrain the same axis
        if a < 0 { a += .pi }
        if a >= .pi { a -= .pi }
        bin = min(7, Int(a / (.pi / 8)))
        binKnown[bin] += 1
      } else if flat {
        c.flatKnown += 1
      }
      guard let d = index.planeDistance(lp.p, normal: lp.n, maxDistance: 0.08) else { continue }
      c.matched += 1
      allDistances.append(d)
      if vertical {
        c.wallMatched += 1
        wallDistances.append(d)
        binMatched[bin] += 1
      } else if flat {
        c.flatMatched += 1
      }
    }
    let good = (0..<8).filter { binKnown[$0] >= 30 && binMatched[$0] * 2 >= binKnown[$0] }
    c.directions = good.count
    for i in good {
      for j in good where j > i {
        let diff = min(j - i, 8 - (j - i)) // circular over 180°
        c.spreadDegrees = max(c.spreadDegrees, Float(diff) * 22.5)
      }
    }
    let distances = wallDistances.isEmpty ? allDistances : wallDistances
    if !distances.isEmpty {
      let sorted = distances.sorted()
      c.median = sorted[sorted.count / 2]
    }
    return c
  }
}

/// Voxel hash of a surface: one centroid + mean normal per 4 cm cell, plus which way the
/// surfaces face in each coarse 20 cm cell. Directions matter: ARKit's normals face the side
/// that was scanned, so the far side of a wall scanned from the next room isn't "known" here.
struct SurfaceIndex {
  static let voxel: Float = 0.04
  static let coarse: Float = 0.2

  var cells: [Int64: Int32] = [:]
  var points: [SIMD3<Float>] = []
  /// mean of the vertex normals in the voxel: length ~1 = one clear side, short = both sides
  /// of something thin (or no normals), which then only counts by point distance
  var normals: [SIMD3<Float>] = []
  /// coarse cell → bit mask of facing directions (bits 0–5: +x −x +y −y +z −z, bit 6: unknown)
  var facing: [Int64: UInt8] = [:]

  static func key(_ p: SIMD3<Float>, _ size: Float) -> Int64 {
    let q = (p / size).rounded(.down)
    return pack(Int64(q.x), Int64(q.y), Int64(q.z))
  }

  static func pack(_ x: Int64, _ y: Int64, _ z: Int64) -> Int64 {
    ((x & 0x1F_FFFF) << 42) | ((y & 0x1F_FFFF) << 21) | (z & 0x1F_FFFF)
  }

  private static let axes: [SIMD3<Float>] = [SIMD3(1, 0, 0), SIMD3(-1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, -1, 0), SIMD3(0, 0, 1), SIMD3(0, 0, -1)]

  /// the facing bit of one vertex normal
  static func facingBit(_ n: SIMD3<Float>) -> UInt8 {
    guard simd_length_squared(n) > 0.25 else { return 1 << 6 }
    var best = 0
    var bestDot: Float = -2
    for (i, a) in axes.enumerated() {
      let d = simd_dot(a, n)
      if d > bestDot { bestDot = d; best = i }
    }
    return 1 << UInt8(best)
  }

  /// facing bits a live normal is compatible with (a 45° wall touches two axes)
  static func compatibleBits(_ n: SIMD3<Float>?) -> UInt8 {
    guard let n, simd_length_squared(n) > 0.25 else { return 0x7F }
    var mask: UInt8 = 1 << 6
    for (i, a) in axes.enumerated() where simd_dot(a, n) > 0.3 { mask |= 1 << UInt8(i) }
    return mask
  }

  /// within ~1–2 coarse cells (20–40 cm) of a saved surface facing the same way
  func isNearSurface(_ p: SIMD3<Float>, normal: SIMD3<Float>? = nil) -> Bool {
    let want = Self.compatibleBits(normal)
    let q = (p / Self.coarse).rounded(.down)
    let x = Int64(q.x), y = Int64(q.y), z = Int64(q.z)
    for dx: Int64 in -1...1 {
      for dy: Int64 in -1...1 {
        for dz: Int64 in -1...1 {
          if let bits = facing[Self.pack(x + dx, y + dy, z + dz)], bits & want != 0 { return true }
        }
      }
    }
    return false
  }

  /// Point-to-plane distance to the nearest saved sample within `maxDistance` whose surface
  /// faces the same way as `normal` (so a wall point doesn't "match" the floor at the
  /// skirting board, or the other side of the wall), or nil
  func planeDistance(_ p: SIMD3<Float>, normal: SIMD3<Float>? = nil, maxDistance: Float) -> Float? {
    let q = (p / Self.voxel).rounded(.down)
    let x = Int64(q.x), y = Int64(q.y), z = Int64(q.z)
    let r = Int64((maxDistance / Self.voxel).rounded(.up))
    var best: Float = maxDistance * maxDistance
    var hit: Int32 = -1
    let liveNormal = normal.flatMap { simd_length_squared($0) > 0.25 ? $0 : nil }
    for dx in -r...r {
      for dy in -r...r {
        for dz in -r...r {
          guard let i = cells[Self.pack(x + dx, y + dy, z + dz)] else { continue }
          let d2 = simd_distance_squared(points[Int(i)], p)
          guard d2 < best else { continue }
          if let liveNormal {
            let n = normals[Int(i)]
            let l = simd_length(n)
            if l > 0.5, simd_dot(n / l, liveNormal) < 0.7 { continue }
          }
          best = d2
          hit = i
        }
      }
    }
    guard hit >= 0 else { return nil }
    let n = normals[Int(hit)]
    let l = simd_length(n)
    let v = p - points[Int(hit)]
    // two-sided or no normal: point distance
    return l > 0.5 ? abs(simd_dot(v, n / l)) : simd_length(v)
  }

  struct Builder {
    private var cells: [Int64: Int32] = [:]
    private var sums: [SIMD3<Float>] = []
    private var normalSums: [SIMD3<Float>] = []
    private var counts: [Float] = []
    private var facing: [Int64: UInt8] = [:]

    mutating func add(_ p: SIMD3<Float>, _ n: SIMD3<Float>) {
      let k = SurfaceIndex.key(p, SurfaceIndex.voxel)
      if let i = cells[k] {
        sums[Int(i)] += p
        normalSums[Int(i)] += n
        counts[Int(i)] += 1
      } else {
        cells[k] = Int32(sums.count)
        sums.append(p)
        normalSums.append(n)
        counts.append(1)
      }
      facing[SurfaceIndex.key(p, SurfaceIndex.coarse), default: 0] |= SurfaceIndex.facingBit(n)
    }

    func finish() -> SurfaceIndex {
      var s = SurfaceIndex()
      s.cells = cells
      s.points = zip(sums, counts).map { $0 / $1 }
      s.normals = zip(normalSums, counts).map { $0 / $1 }
      s.facing = facing
      return s
    }
  }
}

/// Vertex clustering (Rossignac–Borrel): every vertex snaps to its grid cell's average, and
/// triangles that collapse or repeat are dropped. Crude, but fast, robust, and it merges the
/// overlapping copies of the same surface that successive room PLYs contain.
private struct GhostBuilder {
  let cell: Float
  let maxTriangles: Int
  private var cells: [Int64: Int32] = [:]
  private var sums: [SIMD3<Float>] = []
  private var normalSums: [SIMD3<Float>] = []
  private var counts: [Float] = []
  private var triangles: Set<SIMD3<Int32>> = []
  private var order: [SIMD3<Int32>] = []

  init(cell: Float, maxTriangles: Int) {
    self.cell = cell
    self.maxTriangles = maxTriangles
  }

  mutating func addVertex(_ p: SIMD3<Float>, _ n: SIMD3<Float>) -> Int32 {
    let k = SurfaceIndex.key(p, cell)
    if let i = cells[k] {
      sums[Int(i)] += p
      normalSums[Int(i)] += n
      counts[Int(i)] += 1
      return i
    }
    let i = Int32(sums.count)
    cells[k] = i
    sums.append(p)
    normalSums.append(n)
    counts.append(1)
    return i
  }

  mutating func addTriangle(_ a: Int32, _ b: Int32, _ c: Int32) {
    guard a >= 0, b >= 0, c >= 0, a != b, b != c, a != c, order.count < maxTriangles else { return }
    // canonical rotation (keeps the winding) so the same triangle from another file dedupes
    let t: SIMD3<Int32> = a < b && a < c ? SIMD3(a, b, c) : b < c ? SIMD3(b, c, a) : SIMD3(c, a, b)
    if triangles.insert(t).inserted { order.append(t) }
  }

  func finish(inset: Float) -> ZoneReference.Ghost {
    // only keep vertices that ended up in a triangle
    var remap = [Int32](repeating: -1, count: sums.count)
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var indices: [UInt32] = []
    indices.reserveCapacity(order.count * 3)
    for t in order {
      for v in [t.x, t.y, t.z] {
        if remap[Int(v)] < 0 {
          remap[Int(v)] = Int32(positions.count)
          let nSum = normalSums[Int(v)]
          let l = simd_length(nSum)
          let n = l > 1e-4 ? nSum / l : SIMD3<Float>(0, 1, 0)
          // sink the ghost a little behind the surface so the live mesh (same surface) always
          // draws in front of it instead of z-fighting
          positions.append(sums[Int(v)] / counts[Int(v)] - n * inset)
          normals.append(n)
        }
        indices.append(UInt32(remap[Int(v)]))
      }
    }
    return ZoneReference.Ghost(positions: positions, normals: normals, indices: indices)
  }
}

// MARK: - PLY reader (the app's own mesh files; see CoverageEngine.writePLY)

/// Binary little-endian PLY with float x y z (+ optional nx ny nz) per vertex and a face list.
/// Memory-mapped; the property layout is read from the header rather than assumed.
private struct PLYFile {
  let data: Data
  let vertexCount: Int
  let faceCount: Int
  private let bodyStart: Int
  private let vertexStride: Int
  private let offsets: (x: Int, y: Int, z: Int, nx: Int?, ny: Int?, nz: Int?)
  /// face record: bytes of properties before the list, list count size, index size, bytes after
  private let faceLayout: (before: Int, countSize: Int, indexSize: Int, after: Int)

  struct Failure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
  }

  /// Vertex count from the header alone (0 if unreadable)
  static func vertexCount(_ url: URL) -> Int {
    guard let h = try? FileHandle(forReadingFrom: url) else { return 0 }
    defer { try? h.close() }
    let head = String(decoding: (try? h.read(upToCount: 2048)) ?? Data(), as: UTF8.self)
    guard let line = head.split(separator: "\n").first(where: { $0.hasPrefix("element vertex ") }) else { return 0 }
    return Int(line.split(separator: " ").last ?? "") ?? 0
  }

  static func size(of type: String) -> Int? {
    switch type {
    case "char", "uchar", "int8", "uint8": 1
    case "short", "ushort", "int16", "uint16": 2
    case "int", "uint", "float", "int32", "uint32", "float32": 4
    case "double", "float64": 8
    default: nil
    }
  }

  init(url: URL) throws {
    data = try Data(contentsOf: url, options: .alwaysMapped)
    guard let end = data.range(of: Data("end_header\n".utf8), in: 0..<min(data.count, 8192)) else {
      throw Failure(message: "no PLY header")
    }
    bodyStart = end.upperBound
    let header = String(decoding: data[0..<end.lowerBound], as: UTF8.self)
    guard header.contains("format binary_little_endian") else { throw Failure(message: "not binary little-endian") }
    var element = ""
    var vCount = 0, fCount = 0
    var vProps: [(String, String)] = []
    var fBefore = 0, fAfter = 0, countSize = 0, indexSize = 0, sawList = false
    for line in header.split(separator: "\n") {
      let parts = line.split(separator: " ").map(String.init)
      guard let first = parts.first else { continue }
      if first == "element", parts.count >= 3 {
        element = parts[1]
        if element == "vertex" { vCount = Int(parts[2]) ?? 0 }
        if element == "face" { fCount = Int(parts[2]) ?? 0 }
      } else if first == "property" {
        if element == "vertex", parts.count >= 3 {
          vProps.append((parts[1], parts[2]))
        } else if element == "face" {
          if parts.count >= 5, parts[1] == "list" {
            guard let c = Self.size(of: parts[2]), let i = Self.size(of: parts[3]), i == 4 || i == 2 else { throw Failure(message: "unsupported face list") }
            countSize = c; indexSize = i; sawList = true
          } else if parts.count >= 3, let s = Self.size(of: parts[1]) {
            if sawList { fAfter += s } else { fBefore += s }
          }
        }
      }
    }
    var offset = 0
    var named: [String: Int] = [:]
    for (type, name) in vProps {
      guard let s = Self.size(of: type) else { throw Failure(message: "unsupported vertex property \(type)") }
      if ["x", "y", "z", "nx", "ny", "nz"].contains(name) {
        guard type == "float" || type == "float32" else { throw Failure(message: "\(name) isn't float") }
        named[name] = offset
      }
      offset += s
    }
    guard let x = named["x"], let y = named["y"], let z = named["z"] else { throw Failure(message: "no x/y/z") }
    guard fCount == 0 || sawList else { throw Failure(message: "no face list") }
    vertexStride = offset
    offsets = (x, y, z, named["nx"], named["ny"], named["nz"])
    faceLayout = (fBefore, countSize, indexSize, fAfter)
    vertexCount = vCount
    faceCount = fCount
    guard bodyStart + vertexCount * vertexStride <= data.count else { throw Failure(message: "truncated vertices") }
  }

  func forEachVertex(_ body: (Int, SIMD3<Float>, SIMD3<Float>?) -> Void) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let hasNormals = offsets.nx != nil && offsets.ny != nil && offsets.nz != nil
      for i in 0..<vertexCount {
        let base = bodyStart + i * vertexStride
        let p = SIMD3(raw.loadUnaligned(fromByteOffset: base + offsets.x, as: Float.self),
                      raw.loadUnaligned(fromByteOffset: base + offsets.y, as: Float.self),
                      raw.loadUnaligned(fromByteOffset: base + offsets.z, as: Float.self))
        guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { continue }
        var n: SIMD3<Float>?
        if hasNormals {
          n = SIMD3(raw.loadUnaligned(fromByteOffset: base + offsets.nx!, as: Float.self),
                    raw.loadUnaligned(fromByteOffset: base + offsets.ny!, as: Float.self),
                    raw.loadUnaligned(fromByteOffset: base + offsets.nz!, as: Float.self))
        }
        body(i, p, n)
      }
    }
  }

  /// Triangles only (other polygons are skipped); stops at a truncated record
  func forEachFace(_ body: (Int, Int, Int) -> Void) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var at = bodyStart + vertexCount * vertexStride
      let l = faceLayout
      for _ in 0..<faceCount {
        guard at + l.before + l.countSize <= raw.count else { return }
        at += l.before
        let n: Int = switch l.countSize {
        case 1: Int(raw.load(fromByteOffset: at, as: UInt8.self))
        case 2: Int(raw.loadUnaligned(fromByteOffset: at, as: UInt16.self))
        default: Int(raw.loadUnaligned(fromByteOffset: at, as: UInt32.self))
        }
        at += l.countSize
        guard at + n * l.indexSize + l.after <= raw.count else { return }
        if n == 3 {
          var idx = [0, 0, 0]
          for k in 0..<3 {
            idx[k] = l.indexSize == 4
              ? Int(raw.loadUnaligned(fromByteOffset: at + k * 4, as: UInt32.self))
              : Int(raw.loadUnaligned(fromByteOffset: at + k * 2, as: UInt16.self))
          }
          body(idx[0], idx[1], idx[2])
        }
        at += n * l.indexSize + l.after
      }
    }
  }
}

// MARK: - Live mesh sampling

enum LiveMeshSampler {
  /// Up to `limit` world-space vertices (+ normals) of the live LiDAR mesh that the camera is
  /// looking at (0.3–4.5 m away, inside a ~100° cone). Reads ARKit's buffers: the anchors must
  /// be alive (hold them); fine on any thread.
  static func sample(_ anchors: [ARMeshAnchor], camera: simd_float4x4, limit: Int = 3000) -> [ZoneReference.LivePoint] {
    let eye = simd_make_float3(camera.columns.3)
    let forward = -simd_normalize(simd_make_float3(camera.columns.2))
    let near = anchors.filter { simd_distance(simd_make_float3($0.transform.columns.3), eye) < 7 }
    let total = near.reduce(0) { $0 + $1.geometry.vertices.count }
    guard total > 0 else { return [] }
    // oversample 3×: many vertices fall outside the view cone
    let step = max(1, total / (limit * 3))
    var out: [ZoneReference.LivePoint] = []
    out.reserveCapacity(limit)
    for a in near {
      let src = a.geometry.vertices, nsrc = a.geometry.normals
      guard nsrc.count == src.count else { continue }
      let base = src.buffer.contents().advanced(by: src.offset)
      let nbase = nsrc.buffer.contents().advanced(by: nsrc.offset)
      let t = a.transform
      let rot = simd_float3x3(simd_make_float3(t.columns.0), simd_make_float3(t.columns.1), simd_make_float3(t.columns.2))
      var i = 0
      while i < src.count {
        let f = base.advanced(by: i * src.stride).assumingMemoryBound(to: Float.self)
        let w = simd_make_float3(t * SIMD4(f[0], f[1], f[2], 1))
        let v = w - eye
        let d = simd_length(v)
        if d > 0.3, d < 4.5, simd_dot(v / d, forward) > 0.64 {
          let nf = nbase.advanced(by: i * nsrc.stride).assumingMemoryBound(to: Float.self)
          let n = rot * SIMD3(nf[0], nf[1], nf[2])
          let l = simd_length(n)
          out.append(.init(p: w, n: l > 1e-4 ? n / l : .zero))
          if out.count >= limit { return out }
        }
        i += step
      }
    }
    return out
  }
}

// MARK: - Earlier photos of the zone

enum PriorPhotos {
  /// The zone's earlier photos as coverage-engine photos in the zone frame, each with an
  /// occlusion depth grid from the closest depth frame of its session. Photos without a
  /// nearby depth frame are left out: without depth they'd "see" through walls into the next
  /// room and mark it covered. Off main (reads + inflates depth frames).
  static func load(house: HouseProject, zone: String, excludingSession: String?, limit: Int = 2000) -> [CoverageEngine.Photo] {
    var out: [CoverageEngine.Photo] = []
    let sessions = house.placedSessionsInZone(zone).filter { $0.id != excludingSession }.sorted { $0.startedAt > $1.startedAt }
    for s in sessions {
      let bundle = house.bundle(for: s)
      let toZone = simd_float4x4(columnMajor: s.alignment.toZone)
      let frames = bundle.depthFrames
      let framePoses = frames.map { f -> (SIMD3<Float>, SIMD3<Float>) in
        let t = simd_float4x4(columnMajor: f.transform)
        return (simd_make_float3(t.columns.3), simd_make_float3(t.columns.2))
      }
      for p in bundle.photos {
        guard p.transform.count == 16, p.intrinsics.count == 9 else { continue }
        let t = simd_float4x4(columnMajor: p.transform)
        let pos = simd_make_float3(t.columns.3), back = simd_make_float3(t.columns.2)
        // closest depth frame by viewpoint: within 15 cm and ~15°
        var best = -1
        var bestScore = Float.infinity
        for (i, fp) in framePoses.enumerated() {
          let d = simd_distance(fp.0, pos)
          guard d < 0.15, simd_dot(fp.1, back) > 0.965 else { continue }
          let score = d + (1 - simd_dot(fp.1, back)) * 3
          if score < bestScore { bestScore = score; best = i }
        }
        guard best >= 0, let grid = depthGrid(frames[best], bundle: bundle, toZone: toZone) else { continue }
        let world = toZone * t
        let blur = p.blurPixels.map { $0 / Float(max(1, p.width)) * 1920 } ?? 0
        out.append(CoverageEngine.Photo(
          worldToCamera: world.inverse, position: simd_make_float3(world.columns.3),
          fx: p.intrinsics[0], fy: p.intrinsics[4], cx: p.intrinsics[6], cy: p.intrinsics[7],
          width: Float(p.width), height: Float(p.height),
          sharpness: CaptureController.sharpness(blurAt1920: blur), depth: grid, room: -1))
        if out.count >= limit { return out }
      }
    }
    return out
  }

  /// A saved depth frame as the engine's 64×48 median grid (same as DepthRecorder.grid)
  static func depthGrid(_ f: DepthRecorder.Record, bundle: ScanBundle, toZone: simd_float4x4, cells: (Int, Int) = (64, 48)) -> CoverageEngine.DepthGrid? {
    guard f.width > 0, f.height > 0, f.transform.count == 16, f.intrinsics.count == 9,
          let raw = try? Data(contentsOf: bundle.file(f.file)) else { return nil }
    let bytes = f.width * f.height * 2
    var depth = raw
    if raw.count != bytes { // .f16z: raw DEFLATE
      guard let inflated = try? (raw as NSData).decompressed(using: .zlib) as Data, inflated.count == bytes else { return nil }
      depth = inflated
    }
    let conf = try? Data(contentsOf: bundle.file(f.confidence))
    let (gw, gh) = cells
    var buckets = [[Float]](repeating: [], count: gw * gh)
    depth.withUnsafeBytes { (d: UnsafeRawBufferPointer) in
      for y in 0..<f.height {
        let gy = y * gh / f.height
        for x in 0..<f.width {
          let i = y * f.width + x
          let v = Float(d.loadUnaligned(fromByteOffset: i * 2, as: Float16.self))
          guard v > 0, v.isFinite else { continue }
          if let conf, conf.count == f.width * f.height, conf[conf.startIndex + i] < 1 { continue }
          buckets[gy * gw + x * gw / f.width].append(v)
        }
      }
    }
    let values = buckets.map { b -> Float in
      guard !b.isEmpty else { return 0 }
      let s = b.sorted()
      return s[s.count / 2]
    }
    let scale = Float(gw) / Float(f.width)
    let k = f.intrinsics
    let pose = toZone * simd_float4x4(columnMajor: f.transform)
    return CoverageEngine.DepthGrid(
      width: gw, height: gh, values: values, worldToCamera: pose.inverse,
      fx: k[0] * scale, fy: k[4] * scale, cx: k[6] * scale, cy: k[7] * scale)
  }

  /// A few photos of the zone to show while relocalizing ("stand somewhere like this"):
  /// the first photo of each room and the last one of each session, newest sessions first.
  static func landmarks(house: HouseProject, zone: String, limit: Int = 6) -> [URL] {
    var out: [URL] = []
    for s in house.placedSessionsInZone(zone).sorted(by: { $0.startedAt > $1.startedAt }) {
      let bundle = house.bundle(for: s)
      let photos = bundle.photos
      if let last = photos.last { out.append(bundle.file(last.file)) }
      var seen = Set<Int>()
      for p in photos where seen.insert(p.room).inserted { out.append(bundle.file(p.file)) }
      if out.count >= limit { break }
    }
    var unique: [URL] = []
    for u in out where !unique.contains(u) && FileManager.default.fileExists(atPath: u.path) { unique.append(u) }
    return Array(unique.prefix(limit))
  }

  /// Upright thumbnail (the JPEGs carry EXIF orientation 6)
  static func thumbnail(_ url: URL, maxPixel: Int = 360) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }
}
