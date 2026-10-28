import SceneKit
import SwiftUI
import simd

/// Ayna's look: dark graphite, light-grey circles with a thin dark outline, one accent.
/// Lime means done, covered or verified; orange means something needs attention.
enum AynaTheme {
  static let background = Color(hex: 0x1B1B1C)
  static let surface = Color(hex: 0x252528)
  static let raised = Color(hex: 0x3A3A3E)
  static let neutral = Color(hex: 0xB5B5BA)
  static let text = Color.white
  static let secondary = Color(hex: 0x9A9AA0)
  static let lime = Color(hex: 0xB8FF5E)
  /// text and icons on lime
  static let onLime = Color(hex: 0x173404)
  static let orange = Color(hex: 0xEE7F35)
  /// the logo's dot-matrix reflection
  static let reflection = Color(hex: 0x55555A)

  static let uiBackground = UIColor(hex: 0x1B1B1C)
  static let uiSurface = UIColor(hex: 0x252528)
  static let uiNeutral = UIColor(hex: 0xB5B5BA)
  static let uiLime = UIColor(hex: 0xB8FF5E)
  static let uiOrange = UIColor(hex: 0xEE7F35)

  /// cards are 20–24 pt; buttons are pills
  static let cardRadius: CGFloat = 22

  /// Photo detail that reads as complete (the same 85% `CaptureQuality.ready` asks for)
  static let goodDetail = 85
  static func detailColor(_ percent: Int?) -> Color {
    guard let percent else { return secondary }
    return percent >= goodDetail ? lime : orange
  }

  // PostScript names of the bundled fonts (Fonts/, listed under UIAppFonts)
  static let michromaFont = "Michroma-Regular"
  static let dotoBoldFont = "Doto-Bold" // static instance: ROND 100 (round dots), wght 700
  static let dotoBlackFont = "Doto-Black" // static instance: ROND 100 (round dots), wght 900
}

extension Color {
  /// 0xRRGGBB in sRGB
  init(hex: UInt32, opacity: Double = 1) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255, opacity: opacity)
  }
}

extension UIColor {
  /// 0xRRGGBB in sRGB
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
              blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
}

extension Font {
  /// Michroma, the wide geometric face of the logo and titles. Scales with Dynamic Type unless
  /// `fixed` (the camera HUD, whose layout must not move).
  static func michroma(_ size: CGFloat, relativeTo style: TextStyle = .body, fixed: Bool = false) -> Font {
    fixed ? .custom(AynaTheme.michromaFont, fixedSize: size) : .custom(AynaTheme.michromaFont, size: size, relativeTo: style)
  }

  /// Doto, dot-matrix figures like LiDAR points: numbers and counters only
  static func doto(_ size: CGFloat, black: Bool = true, relativeTo style: TextStyle = .body, fixed: Bool = false) -> Font {
    let name = black ? AynaTheme.dotoBlackFont : AynaTheme.dotoBoldFont
    return fixed ? .custom(name, fixedSize: size) : .custom(name, size: size, relativeTo: style)
  }
}

// MARK: - logo

/// "AYNA" in Michroma over the same word in Doto, flipped: the thing and its mirror of points.
/// Each dotted letter is centred under its solid one (column widths = Michroma advances).
struct AynaLogo: View {
  var size: CGFloat = 34

  /// Michroma advance widths (em) of A, Y, N, A
  private static let letters: [(String, CGFloat)] = [("A", 1.062), ("Y", 1.062), ("N", 1.133), ("A", 1.062)]
  /// Doto at this scale has Michroma's cap height (0.70 em vs 0.75 em)
  private static let dotoScale: CGFloat = 1.07

  var body: some View {
    // spacing from the fonts' descenders (Michroma 0.266 em, Doto 0.25 em): ~0.12 em gap at the mirror line
    VStack(spacing: -0.41 * size) {
      row(.michroma(size, fixed: true), color: AynaTheme.text, nudge: 0)
      // Doto's ink sits 0.05 em left of its advance centre
      row(.doto(size * Self.dotoScale, fixed: true), color: AynaTheme.reflection, nudge: 0.05 * size * Self.dotoScale)
        .scaleEffect(x: 1, y: -1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Ayna")
  }

  private func row(_ font: Font, color: Color, nudge: CGFloat) -> some View {
    HStack(spacing: 0) {
      ForEach(Self.letters.indices, id: \.self) { i in
        Text(Self.letters[i].0)
          .font(font)
          .foregroundStyle(color)
          .fixedSize()
          .offset(x: nudge)
          .frame(width: Self.letters[i].1 * size)
      }
    }
  }
}

// MARK: - circles

/// Overlapping light-grey circles with a thin dark outline, one of them the accent: Ayna's
/// shorthand for things on a surface.
struct CircleCluster: View {
  /// centre in fractions of the view's width/height, radius as a fraction of its shorter side
  struct Dot {
    var x: CGFloat
    var y: CGFloat
    var r: CGFloat
    var accent = false
  }

  var dots: [Dot] = CircleCluster.objects
  var fill = AynaTheme.neutral
  var stroke = AynaTheme.background
  var accent = AynaTheme.orange
  var lineWidth: CGFloat = 1.5

  /// a few objects on a table, one of them the one that matters
  static let objects: [Dot] = [
    Dot(x: 0.14, y: 0.36, r: 0.17),
    Dot(x: 0.36, y: 0.56, r: 0.36),
    Dot(x: 0.60, y: 0.36, r: 0.27),
    Dot(x: 0.79, y: 0.62, r: 0.22, accent: true),
    Dot(x: 0.93, y: 0.30, r: 0.12),
  ]

  var body: some View {
    Canvas { ctx, size in
      let unit = min(size.width, size.height)
      for d in dots {
        let r = d.r * unit
        let circle = Path(ellipseIn: CGRect(x: d.x * size.width - r, y: d.y * size.height - r, width: 2 * r, height: 2 * r))
        ctx.fill(circle, with: .color(d.accent ? accent : fill))
        ctx.stroke(circle, with: .color(stroke), lineWidth: lineWidth)
      }
    }
    .accessibilityHidden(true)
  }
}

// MARK: - controls

/// Pill buttons: lime for the main action, raised grey for the rest
struct AynaButtonStyle: ButtonStyle {
  enum Kind { case lime, raised, outline }
  var kind: Kind = .lime
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 52)
      .padding(.horizontal, 18)
      .foregroundStyle(kind == .lime ? AynaTheme.onLime : AynaTheme.text)
      .background(fill, in: Capsule())
      .overlay(Capsule().strokeBorder(kind == .outline ? AynaTheme.raised : .clear, lineWidth: 1))
      .contentShape(Capsule())
      .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
  }

  private var fill: Color {
    switch kind {
    case .lime: AynaTheme.lime
    case .raised: AynaTheme.raised
    case .outline: .clear
    }
  }
}

extension View {
  /// A rounded Ayna card
  func aynaCard(_ fill: Color = AynaTheme.surface, padding: CGFloat = 18) -> some View {
    self.padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(fill, in: RoundedRectangle(cornerRadius: AynaTheme.cardRadius, style: .continuous))
  }
}

/// Small wide caps above a section or a number
struct AynaEyebrow: View {
  let text: String
  var color = AynaTheme.secondary
  var body: some View {
    Text(text.uppercased())
      .font(.michroma(10, relativeTo: .caption2))
      .tracking(1.2)
      .foregroundStyle(color)
  }
}

/// A dot-matrix number with its label
struct DotoMetric: View {
  let value: String
  let label: String
  var tint = AynaTheme.text
  var size: CGFloat = 30
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(value).font(.doto(size, relativeTo: .title)).foregroundStyle(tint).lineLimit(1)
      AynaEyebrow(text: label)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label): \(value)")
  }
}

/// A small status light: lime when something is done, orange when it needs attention
struct StatusDot: View {
  var color: Color
  var body: some View {
    Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
  }
}

// MARK: - thumbnails

/// A bundle photo shown upright (JPEGs keep sensor orientation with EXIF 6), decoded small off
/// the main thread
struct UprightPhoto: View {
  let url: URL
  var maxPixels = 1200
  @State private var image: UIImage?
  var body: some View {
    ZStack {
      AynaTheme.raised
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        ProgressView().tint(AynaTheme.neutral)
      }
    }
    .task(id: url) { image = await ThumbnailStore().upright(url, maxPixels: maxPixels) }
    .accessibilityHidden(true)
  }
}

/// The saved LiDAR mesh of a mirror, rendered small: photo colours when the preview has cached
/// them, matte grey clay otherwise.
struct MirrorThumbnail: View {
  let folder: URL?
  let index: Int
  @State private var image: UIImage?
  @State private var loaded = false
  var body: some View {
    ZStack {
      AynaTheme.raised
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else if loaded {
        CircleCluster(fill: AynaTheme.reflection, stroke: AynaTheme.raised, accent: AynaTheme.reflection, lineWidth: 1)
          .padding(14)
      } else {
        ProgressView().tint(AynaTheme.neutral)
      }
    }
    .task(id: "\(folder?.path ?? "")/\(index)") {
      image = nil
      loaded = false
      if let folder {
        let result = await MirrorThumbnails.shared.image(folder: folder, index: index)
        guard !Task.isCancelled else { return }
        image = result
      }
      loaded = true
    }
    .accessibilityHidden(true)
  }
}

/// Serialize thumbnail work so a list never loads several full meshes concurrently.
/// Cache only small rendered images, not scenes or mesh buffers.
actor MirrorThumbnails {
  static let shared = MirrorThumbnails()
  private let cache = NSCache<NSString, UIImage>()
  init() { cache.totalCostLimit = 24 * 1024 * 1024 }

  func image(folder: URL, index: Int) -> UIImage? {
    let meshURL = folder.appendingPathComponent("mesh/room-\(index).ply")
    let colorURL = folder.appendingPathComponent("mesh/room-\(index)-colors.bin")
    let modelURL = folder.appendingPathComponent("rooms/room-\(index).usdz")
    let dates = [meshURL, colorURL, modelURL].map { (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate?.timeIntervalSince1970) ?? 0 }
    let key = "\(folder.path)/\(index)/\(dates)" as NSString
    if let image = cache.object(forKey: key) { return image }
    let image: UIImage? = autoreleasepool {
      let scene = SCNScene()
      scene.background.contents = AynaTheme.uiSurface
      let content = SCNNode()
      scene.rootNode.addChildNode(content)
      var lo = SIMD3<Float>(repeating: -1), hi = SIMD3<Float>(repeating: 1)
      if let mesh = try? PLYMesh.load(url: meshURL) {
        let room = PreviewRoom(session: 0, index: index, name: "", mesh: meshURL, usdz: nil)
        let asset = MeshAsset(room: room, mesh: mesh)
        lo = asset.insideMin; hi = asset.insideMax
        var sources = [asset.vertexSource, asset.normalSource]
        let colors = mesh.loadCachedColors()
        if let colors { sources.append(MeshAsset.colorSource(colors, count: mesh.vertexCount)) }
        let element = SCNGeometryElement(indices: asset.inside, primitiveType: .triangles)
        let geometry = SCNGeometry(sources: sources, elements: [element])
        let material = SCNMaterial()
        material.diffuse.contents = colors == nil ? AynaTheme.uiNeutral : UIColor.white
        material.lightingModel = colors == nil ? .lambert : .constant
        material.isDoubleSided = false
        geometry.materials = [material]
        content.addChildNode(SCNNode(geometry: geometry))
      } else if let model = try? SCNScene(url: modelURL) {
        for node in model.rootNode.childNodes { content.addChildNode(node) }
        let bounds = content.boundingBox
        lo = SIMD3(bounds.min.x, bounds.min.y, bounds.min.z); hi = SIMD3(bounds.max.x, bounds.max.y, bounds.max.z)
      } else { return nil }
      let center = (lo + hi) / 2
      let extent = max(1, simd_length(hi - lo))
      // isometric-ish, like a clay model on a desk
      let camera = SCNNode(); camera.camera = SCNCamera()
      camera.camera?.usesOrthographicProjection = true
      camera.camera?.orthographicScale = Double(extent * 0.43)
      camera.camera?.zFar = Double(extent * 8)
      camera.simdPosition = center + SIMD3(extent, extent * 0.9, extent)
      camera.look(at: SCNVector3(center.x, center.y, center.z))
      scene.rootNode.addChildNode(camera)
      let light = SCNNode(); light.light = SCNLight(); light.light?.type = .ambient; light.light?.intensity = 650
      scene.rootNode.addChildNode(light)
      let sun = SCNNode(); sun.light = SCNLight(); sun.light?.type = .omni; sun.light?.intensity = 750
      sun.simdPosition = camera.simdPosition; scene.rootNode.addChildNode(sun)
      let renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
      renderer.scene = scene; renderer.pointOfView = camera
      return renderer.snapshot(atTime: 0, with: CGSize(width: 360, height: 360), antialiasingMode: .multisampling4X)
    }
    if let image { cache.setObject(image, forKey: key, cost: 360 * 360 * 4) }
    return image
  }
}
