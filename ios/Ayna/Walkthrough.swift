import ImageIO
import simd
import SwiftUI
import UIKit

/// Bottom panel of the photo walkthrough: where we are, prev/next, a filmstrip of every photo, and
/// the photo ↔ mesh opacity slider (the on-device version of the Mac's photo-vs-model comparison).
struct WalkthroughPanel: View {
  @ObservedObject var model: PreviewModel

  var body: some View {
    VStack(spacing: 12) {
      HStack(spacing: 12) {
        roundButton("chevron.left") { model.previous() }
          .disabled((model.current ?? 0) <= 0)
        VStack(spacing: 2) {
          if let c = model.current, model.photos.indices.contains(c) {
            Text("Photo \(c + 1) of \(model.photos.count)").font(.subheadline.weight(.semibold)).monospacedDigit()
            Text(detail(model.photos[c])).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          } else {
            Text("\(model.photos.count) photos").font(.subheadline.weight(.semibold))
            Text("Tap a camera to jump to it").font(.caption).foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity)
        roundButton("chevron.right") { model.next() }
          .disabled((model.current ?? 0) >= model.photos.count - 1)
      }

      Filmstrip(model: model)

      HStack(spacing: 12) {
        Image(systemName: "cube").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
        Slider(value: $model.photoOpacity, in: 0...1)
          .tint(PreviewTheme.accent)
        Image(systemName: "photo").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
      }
      .opacity(model.atPhoto ? 1 : 0.35)
      .disabled(!model.atPhoto)
    }
    .padding(14)
    .glass(RoundedRectangle(cornerRadius: 30, style: .continuous))
  }

  private func roundButton(_ icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 16, weight: .bold))
        .frame(width: 40, height: 40)
        .background(Circle().fill(Color.white.opacity(0.12)))
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
  }

  private func detail(_ p: PreviewPhoto) -> String {
    var parts: [String] = []
    if let room = model.rooms.first(where: { $0.session == p.session && $0.index == p.room }) { parts.append(room.name) }
    if model.sessions.count > 1, let s = model.sessions.first(where: { $0.index == p.session }) { parts.append(s.title) }
    parts.append(String(format: "%.1f m from start", simd_distance(p.position, model.photos.first?.position ?? p.position)))
    return parts.joined(separator: " · ")
  }
}

private struct Filmstrip: View {
  @ObservedObject var model: PreviewModel

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 6) {
          ForEach(Array(model.photos.enumerated()), id: \.element.id) { i, p in
            Thumb(url: p.url, store: model.thumbnails, selected: model.current == i)
              .id(i)
              .onTapGesture { model.go(to: i) }
          }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 3)
      }
      .frame(height: 70)
      .onChange(of: model.current) { _, c in
        guard let c else { return }
        withAnimation(.easeInOut(duration: 0.3)) { proxy.scrollTo(c, anchor: .center) }
      }
      .onAppear { if let c = model.current { proxy.scrollTo(c, anchor: .center) } }
    }
  }
}

private struct Thumb: View {
  let url: URL
  let store: ThumbnailStore
  let selected: Bool
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Color.white.opacity(0.08)
      }
    }
    .frame(width: 48, height: 64)
    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .strokeBorder(selected ? PreviewTheme.accent : Color.white.opacity(0.1), lineWidth: selected ? 2.5 : 0.5)
    }
    .scaleEffect(selected ? 1.06 : 1)
    .animation(.spring(response: 0.25, dampingFraction: 0.8), value: selected)
    .task(id: url) { image = await store.upright(url, maxPixels: 160) }
  }
}

/// Decoded photo thumbnails, cached. Upright copies for the UI, sensor-orientation copies for the
/// frustum markers (their planes use camera coordinates).
final class ThumbnailStore: @unchecked Sendable {
  private let cache = NSCache<NSString, AnyObject>()

  init() { cache.countLimit = 600 }

  func upright(_ url: URL, maxPixels: Int) async -> UIImage? {
    let key = "u\(maxPixels)-\(url.path)" as NSString
    if let img = cache.object(forKey: key) as? UIImage { return img }
    let img = await Task.detached(priority: .userInitiated) { () -> UIImage? in
      Self.decode(url, maxPixels: maxPixels, upright: true).map { UIImage(cgImage: $0) }
    }.value
    if let img { cache.setObject(img, forKey: key) }
    return img
  }

  func sensor(_ url: URL) async -> CGImage? {
    let key = "s-\(url.path)" as NSString
    if let obj = cache.object(forKey: key) { return (obj as! CGImage) }
    let img = await Task.detached(priority: .utility) { Self.decode(url, maxPixels: 128, upright: false) }.value
    if let img { cache.setObject(img, forKey: key) }
    return img
  }

  private static func decode(_ url: URL, maxPixels: Int, upright: Bool) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: upright,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }
}
