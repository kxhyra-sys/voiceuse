import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import VoiceUseCore

enum CaptureError: Error, CustomStringConvertible {
    case noDisplay
    case encodeFailed
    case permissionDenied

    var description: String {
        switch self {
        case .noDisplay: return "No display to capture."
        case .encodeFailed: return "Could not encode the screenshot."
        case .permissionDenied: return "Screen Recording permission is missing. Enable VoiceUse in System Settings > Privacy & Security > Screen & System Audio Recording, then try again."
        }
    }
}

/// Captures the main display with ScreenCaptureKit at native resolution, then scales it down to
/// what the model can read. VoiceUse's own windows (the HUD) are left out of the picture.
final class ScreenCapturer {
    /// Size of the main display in points. Click coordinates are in this space.
    static var mainDisplayPoints: CGSize { CGDisplayBounds(CGMainDisplayID()).size }

    private let maxLongEdge = 1568
    private let maxPixels = 1_150_000
    private var lastNative: CGImage?

    var scale: ScreenScale {
        let size = Self.mainDisplayPoints
        return ScreenScale(screenWidth: size.width, screenHeight: size.height,
                           maxLongEdge: maxLongEdge, maxPixels: maxPixels)
    }

    func screenshot() async throws -> Screenshot {
        let native = try await captureNative()
        lastNative = native
        let target = scale
        return try encode(native, width: target.shotWidth, height: target.shotHeight)
    }

    /// Crops a region (in screenshot pixels) out of a fresh native-resolution capture.
    func zoom(from: Point, to: Point) async throws -> Screenshot {
        let native = try await captureNative()
        lastNative = native
        let target = scale
        let sx = Double(native.width) / Double(target.shotWidth)
        let sy = Double(native.height) / Double(target.shotHeight)
        let rect = CGRect(x: from.x * sx, y: from.y * sy, width: (to.x - from.x) * sx, height: (to.y - from.y) * sy)
            .integral
            .intersection(CGRect(x: 0, y: 0, width: native.width, height: native.height))
        guard !rect.isEmpty, let cropped = native.cropping(to: rect) else { throw CaptureError.encodeFailed }
        let fitted = ScreenGeometry.fit(width: cropped.width, height: cropped.height,
                                        maxLongEdge: maxLongEdge, maxPixels: maxPixels)
        return try encode(cropped, width: fitted.width, height: fitted.height)
    }

    private func captureNative() async throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.permissionDenied }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw CaptureError.noDisplay
        }
        let ownApps = content.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])

        let pixelScale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int(CGFloat(display.width) * pixelScale)
        config.height = Int(CGFloat(display.height) * pixelScale)
        config.showsCursor = true
        config.capturesAudio = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    private func encode(_ image: CGImage, width: Int, height: Int) throws -> Screenshot {
        let resized: CGImage
        if image.width == width && image.height == height {
            resized = image
        } else {
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
                throw CaptureError.encodeFailed
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let scaled = context.makeImage() else { throw CaptureError.encodeFailed }
            resized = scaled
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CaptureError.encodeFailed
        }
        CGImageDestinationAddImage(destination, resized, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.encodeFailed }
        return Screenshot(data: data as Data, mediaType: "image/jpeg", width: width, height: height)
    }
}
