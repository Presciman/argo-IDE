// Turns a square source image into a macOS app icon that follows Apple's
// icon grid: the artwork is inset inside a 1024pt canvas and masked to the
// system squircle, with the subtle drop shadow the platform expects.
//
// Run:  swift build/make-icon.swift <source.png> <out.png>
//
// A plain rounded rect is deliberately not used. Apple's shape is a
// continuous-curvature squircle, and the difference is visible at Dock size.
// CALayer.cornerCurve = .continuous is the system's own implementation of it,
// so the layer is rendered rather than the path reimplemented by hand.

import AppKit
import QuartzCore

// Apple's macOS icon grid: a 1024pt canvas whose rounded-square body is
// 824pt, leaving 100pt of breathing room for the shadow and for optical
// alignment with other icons in the Dock.
let canvas: CGFloat = 1024
let body: CGFloat = 824
let radius: CGFloat = body * 0.225

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: make-icon.swift <source.png> <out.png>\n".data(using: .utf8)!)
    exit(2)
}

guard let src = NSImage(contentsOfFile: args[1]),
      let loaded = src.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not read \(args[1])\n".data(using: .utf8)!)
    exit(1)
}

/// Crop away a flat black border baked into the source.
///
/// The artwork ships as a full-bleed square whose own rounded corners are
/// filled with opaque black rather than left transparent. Masking that
/// directly leaves a thin black rim just inside the squircle, which reads as a
/// doubled edge. Trimming to the real content first lets the artwork run all
/// the way to the mask. Returns the image unchanged when there is no border.
func trimBlackBorder(_ image: CGImage) -> CGImage {
    let rep = NSBitmapImageRep(cgImage: image)
    let w = rep.pixelsWide, h = rep.pixelsHigh
    // Summed RGB. The body is a dark navy (~0.29) and the border is pure
    // black (0.0), so anything above this is content.
    let threshold = 0.06
    func isContent(_ x: Int, _ y: Int) -> Bool {
        guard let c = rep.colorAt(x: x, y: y) else { return false }
        return c.redComponent + c.greenComponent + c.blueComponent > threshold
    }

    // Scan the centre lines only: the corners are rounded, so an edge-spanning
    // scan would never find content at the extremes.
    let midY = h / 2, midX = w / 2
    var left = 0, right = w - 1, top = 0, bottom = h - 1
    while left < midX && !isContent(left, midY) { left += 1 }
    while right > midX && !isContent(right, midY) { right -= 1 }
    while top < midY && !isContent(midX, top) { top += 1 }
    while bottom > midY && !isContent(midX, bottom) { bottom -= 1 }

    // Keep the crop square and centred so the artwork is not skewed.
    let inset = max(left, w - 1 - right, top, h - 1 - bottom)
    guard inset > 0, inset * 2 < min(w, h) else { return image }
    let rect = CGRect(x: inset, y: inset, width: w - inset * 2, height: h - inset * 2)
    return image.cropping(to: rect) ?? image
}

let srcCG = trimBlackBorder(loaded)

guard let ctx = CGContext(
    data: nil,
    width: Int(canvas),
    height: Int(canvas),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    FileHandle.standardError.write("could not create bitmap context\n".data(using: .utf8)!)
    exit(1)
}

// The masked artwork, drawn by the system so the corner curve matches other
// app icons exactly.
let layer = CALayer()
layer.frame = CGRect(x: 0, y: 0, width: body, height: body)
layer.contents = srcCG
// The source is square and full-bleed; resizeAspectFill avoids letterboxing
// if a future source ever isn't.
layer.contentsGravity = .resizeAspectFill
layer.cornerRadius = radius
layer.cornerCurve = .continuous
layer.masksToBounds = true
layer.isOpaque = false

let inset = (canvas - body) / 2

// Shadow first, as its own pass: rendering the layer inside a shadowed state
// would also blur the artwork's interior edges.
ctx.saveGState()
ctx.setShadow(
    offset: CGSize(width: 0, height: -10),
    blur: 20,
    color: NSColor.black.withAlphaComponent(0.30).cgColor
)
let shadowPath = CGPath(
    roundedRect: CGRect(x: inset, y: inset, width: body, height: body),
    cornerWidth: radius,
    cornerHeight: radius,
    transform: nil
)
ctx.addPath(shadowPath)
ctx.setFillColor(NSColor.black.cgColor)
ctx.fillPath()
ctx.restoreGState()

// Now the artwork itself, on top of the shadow it casts.
ctx.saveGState()
ctx.translateBy(x: inset, y: inset)
layer.render(in: ctx)
ctx.restoreGState()

guard let out = ctx.makeImage() else {
    FileHandle.standardError.write("could not render image\n".data(using: .utf8)!)
    exit(1)
}

let rep = NSBitmapImageRep(cgImage: out)
rep.size = NSSize(width: canvas, height: canvas)
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("could not encode png\n".data(using: .utf8)!)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: args[2]))
print("wrote \(args[2]) (\(Int(canvas))x\(Int(canvas)), body \(Int(body)), radius \(radius))")
