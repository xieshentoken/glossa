// Builds Glossa's app icons from logo.png.
//
//   swift scripts/make-icons.swift
//
// Outputs:
//   assets/icon.png     1024 macOS-style icon (used for the window and the Dock)
//   build/icon.icns     macOS bundle icon (all standard sizes, via iconutil)
//   build/icon.ico      Windows bundle icon (16-256, PNG payloads)
//
// macOS artwork follows Apple's icon grid: a rounded body of 824x824 inside a
// 1024x1024 canvas (radius 185.4) with a soft drop shadow. Windows keeps a
// smaller margin (the tile has no rounded mask of its own).
import AppKit
import CoreGraphics
import Foundation
import ImageIO

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("logo.png")

guard let src = CGImageSourceCreateWithURL(source as CFURL, nil),
      let art = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  FileHandle.standardError.write("Cannot read logo.png in \(root.path)\n".data(using: .utf8)!)
  exit(1)
}

/// Renders the art as a rounded, padded icon of `size` pixels. The shadow is cast by
/// the filled shape in its own pass: a clip would cut away its own shadow.
func render(size: Int, content: CGFloat, radius: CGFloat, shadow: Bool) -> CGImage {
  let side = CGFloat(size)
  let box = side * content
  let inset = (side - box) / 2
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  let path = CGPath(roundedRect: CGRect(x: inset, y: inset, width: box, height: box),
                    cornerWidth: box * radius, cornerHeight: box * radius, transform: nil)
  if shadow {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -side * 0.012), blur: side * 0.029,
                  color: CGColor(colorSpace: space, components: [0, 0, 0, 0.25]))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(colorSpace: space, components: [0, 0, 0, 1])!)
    ctx.fillPath()
    ctx.restoreGState()
  }
  ctx.saveGState()
  ctx.addPath(path)
  ctx.clip()
  ctx.draw(art, in: CGRect(x: inset, y: inset, width: box, height: box))
  ctx.restoreGState()
  return ctx.makeImage()!
}

func png(_ image: CGImage) -> Data {
  let out = NSMutableData()
  let dest = CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  CGImageDestinationFinalize(dest)
  return out as Data
}

func write(_ data: Data, to relative: String) throws {
  let url = root.appendingPathComponent(relative)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try data.write(to: url)
}

// macOS: an 824/1024 body with a 0.255 radius and a soft shadow, measured against
// Apple's own app icons (solid silhouette 0.617 of the canvas, 0.836 with the shadow).
let macContent: CGFloat = 824.0 / 1024.0
let macRadius: CGFloat = 0.255
// Windows: a slightly larger body; the OS does not mask app icons.
let winContent: CGFloat = 0.94
let winRadius: CGFloat = 0.17

let mac = { (size: Int) in render(size: size, content: macContent, radius: macRadius, shadow: true) }
let win = { (size: Int) in render(size: size, content: winContent, radius: winRadius, shadow: false) }

try write(png(mac(1024)), to: "assets/icon.png")

// .iconset for iconutil (names are fixed by Apple).
let iconset = "build/icon.iconset/"
for (name, size) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
                     ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
                     ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
  try write(png(mac(size)), to: iconset + name + ".png")
}

// .ico: header, one 16-byte entry per image, then PNG payloads.
let icoSizes = [16, 24, 32, 48, 64, 128, 256]
let images = icoSizes.map { png(win($0)) }
var ico = Data([0, 0, 1, 0, UInt8(icoSizes.count), 0])
var offset = 6 + 16 * icoSizes.count
for (i, size) in icoSizes.enumerated() {
  let data = images[i]
  ico.append(contentsOf: [UInt8(size == 256 ? 0 : size), UInt8(size == 256 ? 0 : size), 0, 0])
  ico.append(contentsOf: [1, 0, 32, 0])
  ico.append(contentsOf: withUnsafeBytes(of: UInt32(data.count).littleEndian) { Array($0) })
  ico.append(contentsOf: withUnsafeBytes(of: UInt32(offset).littleEndian) { Array($0) })
  offset += data.count
}
for data in images { ico.append(data) }
try write(ico, to: "build/icon.ico")

print("Wrote assets/icon.png, build/icon.iconset, build/icon.ico")
