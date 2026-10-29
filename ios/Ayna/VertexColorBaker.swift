import CoreGraphics
import Foundation
import ImageIO
import simd

/// Paints every mesh vertex with the color the photos saw there.
///
/// For each photo: decode a small copy (sensor orientation, which is what the intrinsics describe),
/// rasterize the mesh into a low-res depth buffer from that camera (so a vertex hidden behind a chair
/// doesn't get the chair's color), then for every vertex it can see, weigh the photo by how head-on and
/// close it looked (pixels per meter), how sharp it was and how far from the frame edge the vertex is.
/// Colors are blended in linear light with weight³, so the best photo dominates but seams stay soft.
/// Work is split into batches of photos × chunks of consecutive vertices (spatially coherent: one
/// ARKit anchor after another), so chunks a photo can't see are skipped wholesale.
///
/// The inner loops are written with scalar math on raw pointers and `while` loops (no SIMD types,
/// ranges or array subscripts) so Debug builds (-Onone) stay usable.
enum VertexColorBaker {
  struct Result {
    var rgba: [UInt8]
    /// vertices at least one photo saw
    var seen: Int
    var seconds: Double
  }

  private static let chunkSize = 1024
  private static let thumbMax = 512
  private static let zWidth = 192
  private static let maxDistance: Float = 6

  /// `progress(fraction, colorsSoFar)`: colors are included about twice a second so the mesh can paint
  /// itself in. Called on the baking thread. Returns nil when cancelled.
  static func bake(mesh: PLYMesh, photos: [PreviewPhoto],
                   progress: (Double, [UInt8]?) -> Void,
                   isCancelled: () -> Bool) -> Result? {
    mesh.positions.withUnsafeBufferPointer { pos in
      mesh.normals.withUnsafeBufferPointer { nor in
        mesh.indices.withUnsafeBufferPointer { idx in
          bake(n: mesh.vertexCount, faces: mesh.faceCount, pos: pos.baseAddress!, nor: nor.baseAddress!, idx: idx.baseAddress!,
               photos: photos, progress: progress, isCancelled: isCancelled)
        }
      }
    }
  }

  /// raw pointers shared by all workers (read-only)
  private struct Context: @unchecked Sendable {
    let pos: UnsafePointer<Float>
    let nor: UnsafePointer<Float>
    let idx: UnsafePointer<UInt32>
    let n: Int
    let chunks: Int
    /// per chunk: center xyz + radius
    let spheres: UnsafePointer<Float>
    let triStart: UnsafePointer<Int>
    let triOrder: UnsafePointer<UInt32>
    let toLinear: UnsafePointer<Float>
  }

  @_optimize(speed)
  private static func bake(n: Int, faces: Int, pos: UnsafePointer<Float>, nor: UnsafePointer<Float>, idx: UnsafePointer<UInt32>,
                           photos: [PreviewPhoto], progress: (Double, [UInt8]?) -> Void, isCancelled: () -> Bool) -> Result? {
    let t0 = CFAbsoluteTimeGetCurrent()
    let chunks = (n + chunkSize - 1) / chunkSize
    return withContext(n: n, faces: faces, pos: pos, nor: nor, idx: idx) { ctx in

      // r, g, b, weight per vertex
      let acc = UnsafeMutablePointer<Float>.allocate(capacity: n * 4)
      acc.initialize(repeating: 0, count: n * 4)
      defer { acc.deallocate() }
      let order = spreadOrder(photos.count)
      let batch = Swift.max(4, ProcessInfo.processInfo.activeProcessorCount * 2)
      var lastEmit = CFAbsoluteTimeGetCurrent()

      var done = 0
      while done < order.count {
        if isCancelled() { return nil }
        let ids = Array(order[done..<Swift.min(order.count, done + batch)])
        // prepare photos in parallel
        var works = [PhotoWork?](repeating: nil, count: ids.count)
        works.withUnsafeMutableBufferPointer { w in
          let wp = w.baseAddress!
          DispatchQueue.concurrentPerform(iterations: ids.count) { k in
            wp[k] = prepare(photos[ids[k]], ctx)
          }
        }
        let ready = works.compactMap { $0 }
        if !ready.isEmpty {
          // accumulate over vertex chunks in parallel (each chunk owns its vertices: no contention)
          let groups = (chunks + 7) / 8
          DispatchQueue.concurrentPerform(iterations: groups) { g in
            var c = g * 8
            let end = Swift.min(chunks, c + 8)
            while c < end {
              for w in ready where w.visible[c] != 0 { accumulate(w, chunk: c, ctx, acc: acc) }
              c += 1
            }
          }
        }
        for w in ready { w.free() }
        done += ids.count
        let now = CFAbsoluteTimeGetCurrent()
        if now - lastEmit > 0.5 && done < order.count {
          lastEmit = now
          progress(Double(done) / Double(order.count), resolve(acc, n: n, normals: nor).rgba)
        } else {
          progress(Double(done) / Double(order.count), nil)
        }
      }
      var result = resolve(acc, n: n, normals: nor)
      result.seconds = CFAbsoluteTimeGetCurrent() - t0
      return result
    }
  }

  /// Reuse the same occlusion geometry for color baking and high-resolution photo selection.
  private static func withContext<T>(n: Int, faces: Int, pos: UnsafePointer<Float>, nor: UnsafePointer<Float>,
                                     idx: UnsafePointer<UInt32>, _ body: (Context) -> T) -> T {
    let chunks = (n + chunkSize - 1) / chunkSize
    // chunk bounding spheres
    let spheres = UnsafeMutablePointer<Float>.allocate(capacity: chunks * 4)
    defer { spheres.deallocate() }
    DispatchQueue.concurrentPerform(iterations: chunks) { c in
      var lx = Float.greatestFiniteMagnitude, ly = lx, lz = lx
      var hx = -lx, hy = -lx, hz = -lx
      var i = c * chunkSize
      let end = Swift.min(n, i + chunkSize)
      while i < end {
        let x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
        if x < lx { lx = x }; if x > hx { hx = x }
        if y < ly { ly = y }; if y > hy { hy = y }
        if z < lz { lz = z }; if z > hz { hz = z }
        i += 1
      }
      spheres[4 * c] = (lx + hx) / 2
      spheres[4 * c + 1] = (ly + hy) / 2
      spheres[4 * c + 2] = (lz + hz) / 2
      let dx = hx - lx, dy = hy - ly, dz = hz - lz
      spheres[4 * c + 3] = (dx * dx + dy * dy + dz * dz).squareRoot() / 2
    }
    // triangles grouped by the chunk of their first vertex (counting sort), for the depth buffers
    let triStart = UnsafeMutablePointer<Int>.allocate(capacity: chunks + 1)
    triStart.initialize(repeating: 0, count: chunks + 1)
    let triOrder = UnsafeMutablePointer<UInt32>.allocate(capacity: Swift.max(1, faces))
    let fill = UnsafeMutablePointer<Int>.allocate(capacity: chunks + 1)
    defer { triStart.deallocate(); triOrder.deallocate(); fill.deallocate() }
    var f = 0
    while f < faces { triStart[Int(idx[3 * f]) / chunkSize + 1] += 1; f += 1 }
    var c = 0
    while c < chunks { triStart[c + 1] += triStart[c]; c += 1 }
    fill.update(from: triStart, count: chunks + 1)
    f = 0
    while f < faces {
      let k = Int(idx[3 * f]) / chunkSize
      triOrder[fill[k]] = UInt32(f)
      fill[k] += 1
      f += 1
    }
    let lut = UnsafeMutablePointer<Float>.allocate(capacity: 256)
    defer { lut.deallocate() }
    for i in 0..<256 {
      let v = Float(i) / 255
      lut[i] = v <= 0.04045 ? v / 12.92 : powf((v + 0.055) / 1.055, 2.4)
    }
    let ctx = Context(pos: pos, nor: nor, idx: idx, n: n, chunks: chunks, spheres: spheres, triStart: triStart, triOrder: triOrder, toLinear: lut)

    return body(ctx)
  }

  /// Best unobstructed source photo for each displayed triangle. -1 means no usable view.
  static func assignPhotos(mesh: PLYMesh, triangles: [UInt32], photos: [PreviewPhoto],
                           progress: (Double) -> Void, isCancelled: () -> Bool) -> [Int32]? {
    mesh.positions.withUnsafeBufferPointer { pos in
      mesh.normals.withUnsafeBufferPointer { nor in
        mesh.indices.withUnsafeBufferPointer { idx in
          withContext(n: mesh.vertexCount, faces: mesh.faceCount, pos: pos.baseAddress!, nor: nor.baseAddress!, idx: idx.baseAddress!) { ctx in
            var winners = [Int32](repeating: -1, count: triangles.count / 3)
            var scores = [Float](repeating: 0, count: winners.count)
            for (photoIndex, photo) in photos.enumerated() {
              if isCancelled() { return nil }
              autoreleasepool {
                guard let work = prepare(photo, ctx) else { return }
                defer { work.free() }
                triangles.withUnsafeBufferPointer { tris in
                  winners.withUnsafeMutableBufferPointer { win in
                    scores.withUnsafeMutableBufferPointer { score in
                      chooseTriangles(work, ctx, tris.baseAddress!, count: win.count,
                                      photoIndex: Int32(photoIndex), winners: win.baseAddress!, scores: score.baseAddress!)
                    }
                  }
                }
              }
              progress(Double(photoIndex + 1) / Double(max(1, photos.count)))
            }
            return winners
          }
        }
      }
    }
  }

  @_optimize(speed)
  private static func chooseTriangles(_ w: PhotoWork, _ ctx: Context, _ triangles: UnsafePointer<UInt32>, count: Int,
                                      photoIndex: Int32, winners: UnsafeMutablePointer<Int32>, scores: UnsafeMutablePointer<Float>) {
    let m = w.m
    DispatchQueue.concurrentPerform(iterations: (count + 4095) / 4096) { block in
      var f = block * 4096
      let end = min(count, f + 4096)
      while f < end {
        defer { f += 1 }
        let ids = (Int(triangles[3 * f]), Int(triangles[3 * f + 1]), Int(triangles[3 * f + 2]))
        if w.visible[ids.0 / chunkSize] == 0 && w.visible[ids.1 / chunkSize] == 0 && w.visible[ids.2 / chunkSize] == 0 { continue }
        var center = SIMD3<Float>.zero, normal = SIMD3<Float>.zero
        var minEdge: Float = 1
        var visible = true
        // Check all corners and the center, not just one vertex behind an occluder.
        for corner in 0..<4 {
          let p: SIMD3<Float>
          if corner < 3 {
            let i = corner == 0 ? ids.0 : corner == 1 ? ids.1 : ids.2
            p = SIMD3(ctx.pos[3 * i], ctx.pos[3 * i + 1], ctx.pos[3 * i + 2])
            center += p / 3
            normal += SIMD3(ctx.nor[3 * i], ctx.nor[3 * i + 1], ctx.nor[3 * i + 2])
          } else { p = center }
          let d = -(m.8 * p.x + m.9 * p.y + m.10 * p.z + m.11)
          if !d.isFinite || d <= 0.15 || d >= maxDistance { visible = false; break }
          let u = w.fx * (m.0 * p.x + m.1 * p.y + m.2 * p.z + m.3) / d + w.cx
          let v = -w.fy * (m.4 * p.x + m.5 * p.y + m.6 * p.z + m.7) / d + w.cy
          if !u.isFinite || !v.isFinite || u < 2 || v < 2 || u >= w.width - 2 || v >= w.height - 2 { visible = false; break }
          let zx = min(w.zw - 1, Int(u * Float(w.zw) / w.width))
          let zy = min(w.zh - 1, Int(v * Float(w.zh) / w.height))
          let surface = w.depth[zy * w.zw + zx]
          if d > surface + 0.04 + 0.025 * surface { visible = false; break }
          let edge = min(min(u, w.width - u), min(v, w.height - v)) / (0.12 * min(w.width, w.height))
          minEdge = min(minEdge, edge)
        }
        if !visible { continue }
        let toCamera = SIMD3(w.px, w.py, w.pz) - center
        let distance = simd_length(toCamera), normalLength = simd_length(normal)
        let facing: Float = normalLength > 1e-6 ? simd_dot(normal / normalLength, toCamera / distance) : 0.5
        if !facing.isFinite || facing <= 0.12 { continue }
        let quality = w.fx * facing / max(0.15, distance) * w.sharpness * (0.1 + 0.9 * minEdge)
        if quality > scores[f] * 1.12 {
          scores[f] = quality
          winners[f] = photoIndex
        }
      }
    }
  }

  // MARK: - per photo

  private struct PhotoWork: @unchecked Sendable {
    /// world → camera, rows of the 3×4 matrix
    var m: (Float, Float, Float, Float, Float, Float, Float, Float, Float, Float, Float, Float)
    var px: Float, py: Float, pz: Float
    var fx: Float, fy: Float, cx: Float, cy: Float
    var width: Float, height: Float
    var sharpness: Float
    var gain: Float
    var pixels: UnsafeMutablePointer<UInt8> // RGBA, tw × th, sensor orientation
    var tw: Int, th: Int
    var depth: UnsafeMutablePointer<Float> // zw × zh, meters along the view axis
    var zw: Int, zh: Int
    var visible: UnsafeMutablePointer<UInt8> // per chunk
    func free() { pixels.deallocate(); depth.deallocate(); visible.deallocate() }
  }

  @_optimize(speed)
  private static func prepare(_ photo: PreviewPhoto, _ ctx: Context) -> PhotoWork? {
    let w2c = photo.cameraToHouse.inverse
    let m = (w2c.columns.0.x, w2c.columns.1.x, w2c.columns.2.x, w2c.columns.3.x,
             w2c.columns.0.y, w2c.columns.1.y, w2c.columns.2.y, w2c.columns.3.y,
             w2c.columns.0.z, w2c.columns.1.z, w2c.columns.2.z, w2c.columns.3.z)
    let W = Float(photo.width), H = Float(photo.height)
    let fx = photo.fx, fy = photo.fy, cx = photo.cx, cy = photo.cy
    // frustum side planes in camera space (camera looks down -Z): inside when dot(n, p) <= r
    let p0 = simd_normalize(SIMD3(fx, 0, W - cx)), p1 = simd_normalize(SIMD3(-fx, 0, cx))
    let p2 = simd_normalize(SIMD3(0, fy, cy)), p3 = simd_normalize(SIMD3(0, -fy, H - cy))
    let a0 = p0.x, c0 = p0.z, a1 = p1.x, c1 = p1.z, b2 = p2.y, c2 = p2.z, b3 = p3.y, c3 = p3.z
    let chunks = ctx.chunks
    let visible = UnsafeMutablePointer<UInt8>.allocate(capacity: chunks)
    visible.initialize(repeating: 0, count: chunks)
    var any = false
    let sp = ctx.spheres
    var c = 0
    while c < chunks {
      let x = sp[4 * c], y = sp[4 * c + 1], z = sp[4 * c + 2], r = sp[4 * c + 3]
      let qx = m.0 * x + m.1 * y + m.2 * z + m.3
      let qy = m.4 * x + m.5 * y + m.6 * z + m.7
      let qz = m.8 * x + m.9 * y + m.10 * z + m.11
      let d = -qz
      if d > -r, d - r < maxDistance,
         a0 * qx + c0 * qz <= r, a1 * qx + c1 * qz <= r,
         b2 * qy + c2 * qz <= r, b3 * qy + c3 * qz <= r {
        visible[c] = 1
        any = true
      }
      c += 1
    }
    guard any, let (pixels, tw, th) = decode(photo.url) else { visible.deallocate(); return nil }

    // depth buffer
    let zw = zWidth, zh = Swift.max(1, Int((Float(zWidth) * H / W).rounded()))
    let zs = Float(zw) / W
    let z = UnsafeMutablePointer<Float>.allocate(capacity: zw * zh)
    z.initialize(repeating: .infinity, count: zw * zh)
    let pos = ctx.pos, idx = ctx.idx
    let sfx = fx * zs, sfy = fy * zs, scx = cx * zs, scy = cy * zs
    let zwF = Float(zw), zhF = Float(zh)
    c = 0
    while c < chunks {
      if visible[c] == 0 { c += 1; continue }
      var t = ctx.triStart[c]
      let tEnd = ctx.triStart[c + 1]
      while t < tEnd {
        let f = Int(ctx.triOrder[t])
        t += 1
        let ia = Int(idx[3 * f]) * 3, ib = Int(idx[3 * f + 1]) * 3, ic = Int(idx[3 * f + 2]) * 3
        let axw = pos[ia], ayw = pos[ia + 1], azw = pos[ia + 2]
        let bxw = pos[ib], byw = pos[ib + 1], bzw = pos[ib + 2]
        let cxw = pos[ic], cyw = pos[ic + 1], czw = pos[ic + 2]
        let da = -(m.8 * axw + m.9 * ayw + m.10 * azw + m.11)
        let db = -(m.8 * bxw + m.9 * byw + m.10 * bzw + m.11)
        let de = -(m.8 * cxw + m.9 * cyw + m.10 * czw + m.11)
        if da < 0.08 || db < 0.08 || de < 0.08 { continue }
        let ax = sfx * (m.0 * axw + m.1 * ayw + m.2 * azw + m.3) / da + scx
        let ay = -sfy * (m.4 * axw + m.5 * ayw + m.6 * azw + m.7) / da + scy
        let bx = sfx * (m.0 * bxw + m.1 * byw + m.2 * bzw + m.3) / db + scx
        let by = -sfy * (m.4 * bxw + m.5 * byw + m.6 * bzw + m.7) / db + scy
        let ex = sfx * (m.0 * cxw + m.1 * cyw + m.2 * czw + m.3) / de + scx
        let ey = -sfy * (m.4 * cxw + m.5 * cyw + m.6 * czw + m.7) / de + scy
        var fminX = ax, fmaxX = ax, fminY = ay, fmaxY = ay
        if bx < fminX { fminX = bx }; if bx > fmaxX { fmaxX = bx }
        if ex < fminX { fminX = ex }; if ex > fmaxX { fmaxX = ex }
        if by < fminY { fminY = by }; if by > fmaxY { fmaxY = by }
        if ey < fminY { fminY = ey }; if ey > fmaxY { fmaxY = ey }
        if fmaxX < 0 || fmaxY < 0 || fminX >= zwF || fminY >= zhF { continue }
        var dmin = da
        if db < dmin { dmin = db }
        if de < dmin { dmin = de }
        // the pixel under the centroid always gets the triangle (sub-pixel triangles leave no holes)
        let gxf = (ax + bx + ex) / 3, gyf = (ay + by + ey) / 3
        if gxf >= 0, gyf >= 0, gxf < zwF, gyf < zhF {
          let k = Int(gyf) * zw + Int(gxf)
          if dmin < z[k] { z[k] = dmin }
        }
        let minX = fminX < 0 ? 0 : Int(fminX), maxX = fmaxX >= zwF - 1 ? zw - 1 : Int(fmaxX)
        let minY = fminY < 0 ? 0 : Int(fminY), maxY = fmaxY >= zhF - 1 ? zh - 1 : Int(fmaxY)
        if maxX == minX && maxY == minY { continue }
        let area = (bx - ax) * (ey - ay) - (by - ay) * (ex - ax)
        if area > -1e-6 && area < 1e-6 { continue }
        let inv = 1 / area
        var py = minY
        while py <= maxY {
          let fy0 = Float(py) + 0.5
          var pxi = minX
          while pxi <= maxX {
            let fx0 = Float(pxi) + 0.5
            let w0 = ((bx - fx0) * (ey - fy0) - (by - fy0) * (ex - fx0)) * inv
            let w1 = ((ex - fx0) * (ay - fy0) - (ey - fy0) * (ax - fx0)) * inv
            let w2 = 1 - w0 - w1
            if w0 >= 0 && w1 >= 0 && w2 >= 0 {
              let dz = w0 * da + w1 * db + w2 * de
              let k = py * zw + pxi
              if dz < z[k] { z[k] = dz }
            }
            pxi += 1
          }
          py += 1
        }
      }
      c += 1
    }
    let camPos = photo.position
    return PhotoWork(m: m, px: camPos.x, py: camPos.y, pz: camPos.z,
                     fx: fx, fy: fy, cx: cx, cy: cy, width: W, height: H, sharpness: photo.sharpness, gain: photo.gain,
                     pixels: pixels, tw: tw, th: th, depth: z, zw: zw, zh: zh, visible: visible)
  }

  /// A small RGBA copy of the JPEG in its stored (sensor) orientation
  private static func decode(_ url: URL, maxPixels: Int = thumbMax) -> (UnsafeMutablePointer<UInt8>, Int, Int)? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: false,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    let w = img.width, h = img.height
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4)
    guard let ctx = CGContext(data: buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
      buf.deallocate()
      return nil
    }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (buf, w, h)
  }

  // MARK: - per vertex

  @_optimize(speed)
  private static func accumulate(_ w: PhotoWork, chunk c: Int, _ ctx: Context, acc: UnsafeMutablePointer<Float>) {
    let pos = ctx.pos, nor = ctx.nor, lin = ctx.toLinear
    let px = w.pixels, z = w.depth
    let m = w.m
    let W = w.width, H = w.height
    let s = Float(w.tw) / W
    let zs = Float(w.zw) / W
    let edgeBand = 0.12 * (W < H ? W : H)
    let twMax = Float(w.tw) - 1.001, thMax = Float(w.th) - 1.001
    let rowBytes = w.tw * 4
    let fx = w.fx, fy = w.fy, cx = w.cx, cy = w.cy
    let camX = w.px, camY = w.py, camZ = w.pz
    let zw = w.zw, zh = w.zh
    let sharp = w.sharpness, gain = w.gain
    var i = c * chunkSize - 1
    let end = Swift.min(ctx.n, c * chunkSize + chunkSize)
    while true {
      i += 1
      if i >= end { break }
      let x = pos[3 * i], y = pos[3 * i + 1], zz = pos[3 * i + 2]
      let d = -(m.8 * x + m.9 * y + m.10 * zz + m.11)
      if d <= 0.15 || d >= maxDistance { continue }
      let u = fx * (m.0 * x + m.1 * y + m.2 * zz + m.3) / d + cx
      let v = -fy * (m.4 * x + m.5 * y + m.6 * zz + m.7) / d + cy
      if u < 1 || u >= W - 1 || v < 1 || v >= H - 1 { continue }
      let nx = nor[3 * i], ny = nor[3 * i + 1], nz = nor[3 * i + 2]
      var cosT: Float = 0.5
      if nx != 0 || ny != 0 || nz != 0 {
        let tx = camX - x, ty = camY - y, tz = camZ - zz
        let len = (tx * tx + ty * ty + tz * tz).squareRoot()
        cosT = (nx * tx + ny * ty + nz * tz) / len
        if cosT <= 0.08 { continue }
      }
      // hidden behind something closer to the camera?
      var zi = Int(u * zs), zj = Int(v * zs)
      if zi >= zw { zi = zw - 1 }
      if zj >= zh { zj = zh - 1 }
      let surface = z[zj * zw + zi]
      if d > surface + 0.03 + 0.025 * surface { continue }
      var edge = u
      if W - u < edge { edge = W - u }
      if v < edge { edge = v }
      if H - v < edge { edge = H - v }
      edge /= edgeBand
      if edge > 1 { edge = 1 }
      edge = edge * edge * (3 - 2 * edge)
      let density = fx * cosT / d / 1000 // ~1 at 1.3 m head-on
      let q = density * sharp * (0.05 + 0.95 * edge)
      let weight = q * q * q
      if weight <= 1e-7 { continue }
      // bilinear sample of the thumbnail
      var sx = u * s - 0.5, sy = v * s - 0.5
      if sx < 0 { sx = 0 }; if sx > twMax { sx = twMax }
      if sy < 0 { sy = 0 }; if sy > thMax { sy = thMax }
      let x0 = Int(sx), y0 = Int(sy)
      let fx0 = sx - Float(x0), fy0 = sy - Float(y0)
      let o00 = y0 * rowBytes + x0 * 4, o10 = o00 + 4, o01 = o00 + rowBytes, o11 = o01 + 4
      let w00 = (1 - fx0) * (1 - fy0), w10 = fx0 * (1 - fy0), w01 = (1 - fx0) * fy0, w11 = fx0 * fy0
      let r = lin[Int(px[o00])] * w00 + lin[Int(px[o10])] * w10 + lin[Int(px[o01])] * w01 + lin[Int(px[o11])] * w11
      let g = lin[Int(px[o00 + 1])] * w00 + lin[Int(px[o10 + 1])] * w10 + lin[Int(px[o01 + 1])] * w01 + lin[Int(px[o11 + 1])] * w11
      let b = lin[Int(px[o00 + 2])] * w00 + lin[Int(px[o10 + 2])] * w10 + lin[Int(px[o01 + 2])] * w01 + lin[Int(px[o11 + 2])] * w11
      let k = weight * gain
      acc[4 * i] += r * k
      acc[4 * i + 1] += g * k
      acc[4 * i + 2] += b * k
      acc[4 * i + 3] += weight
    }
  }

  private static let srgbTable: [UInt8] = (0..<4096).map { i in
    let c = Float(i) / 4095
    let s = c <= 0.0031308 ? c * 12.92 : 1.055 * powf(c, 1 / 2.4) - 0.055
    return UInt8(max(0, min(255, (s * 255).rounded())))
  }

  @_optimize(speed)
  private static func resolve(_ acc: UnsafeMutablePointer<Float>, n: Int, normals: UnsafePointer<Float>) -> Result {
    var out = [UInt8](repeating: 255, count: n * 4)
    let blocks = (n + 65535) / 65536
    var seenPer = [Int](repeating: 0, count: blocks)
    srgbTable.withUnsafeBufferPointer { tb in
      let srgb = tb.baseAddress!
      out.withUnsafeMutableBufferPointer { ob in
        let o = ob.baseAddress!
        seenPer.withUnsafeMutableBufferPointer { spb in
          let sp = spb.baseAddress!
          DispatchQueue.concurrentPerform(iterations: blocks) { b in
            var seen = 0
            var i = b * 65536
            let end = Swift.min(n, i + 65536)
            while i < end {
              let wsum = acc[4 * i + 3]
              if wsum > 0 {
                var r = acc[4 * i] / wsum, g = acc[4 * i + 1] / wsum, bl = acc[4 * i + 2] / wsum
                if r > 1 { r = 1 }; if g > 1 { g = 1 }; if bl > 1 { bl = 1 }
                o[4 * i] = srgb[Int(r * 4095)]
                o[4 * i + 1] = srgb[Int(g * 4095)]
                o[4 * i + 2] = srgb[Int(bl * 4095)]
                seen += 1
              } else {
                // never photographed: neutral clay, shaded a little by the normal so shapes still read
                let ny = normals[3 * i + 1]
                let gray = UInt8(118 + 40 * (0.5 + 0.5 * ny))
                o[4 * i] = gray
                o[4 * i + 1] = gray
                o[4 * i + 2] = gray &+ 6
              }
              i += 1
            }
            sp[b] = seen
          }
        }
      }
    }
    return Result(rgba: out, seen: seenPer.reduce(0, +), seconds: 0)
  }

  /// 0..<n in an order that jumps around (golden-ratio stride), so a partial bake covers the whole house
  private static func spreadOrder(_ n: Int) -> [Int] {
    guard n > 2 else { return Array(0..<n) }
    var step = max(1, Int(Double(n) * 0.618))
    while gcd(step, n) != 1 { step += 1 }
    return (0..<n).map { ($0 * step) % n }
  }

  private static func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }
}
