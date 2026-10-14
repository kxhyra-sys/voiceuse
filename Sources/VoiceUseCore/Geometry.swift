import Foundation

public enum ScreenGeometry {
    /// Largest size that keeps the aspect ratio and fits both the long-edge and total-pixel limits.
    /// Never upscales.
    public static func fit(width: Int, height: Int, maxLongEdge: Int, maxPixels: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (max(width, 1), max(height, 1)) }
        let w = Double(width), h = Double(height)
        let scale = min(1.0, Double(maxLongEdge) / max(w, h), (Double(maxPixels) / (w * h)).squareRoot())
        return (max(1, Int((w * scale).rounded(.down))), max(1, Int((h * scale).rounded(.down))))
    }
}

/// Maps between the screenshot Claude sees and the screen's point space.
public struct ScreenScale: Equatable, Sendable {
    public let screenWidth: Double
    public let screenHeight: Double
    public let shotWidth: Int
    public let shotHeight: Int

    public init(screenWidth: Double, screenHeight: Double, maxLongEdge: Int = 1568, maxPixels: Int = 1_150_000) {
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        let fitted = ScreenGeometry.fit(width: Int(screenWidth), height: Int(screenHeight),
                                        maxLongEdge: maxLongEdge, maxPixels: maxPixels)
        self.shotWidth = fitted.width
        self.shotHeight = fitted.height
    }

    /// Screenshot pixels to screen points, clamped onto the screen.
    public func toScreen(_ p: Point) -> Point {
        let x = p.x * screenWidth / Double(shotWidth)
        let y = p.y * screenHeight / Double(shotHeight)
        return Point(min(max(x, 0), screenWidth - 1), min(max(y, 0), screenHeight - 1))
    }

    /// Screen points to screenshot pixels.
    public func toShot(_ p: Point) -> Point {
        Point(p.x * Double(shotWidth) / screenWidth, p.y * Double(shotHeight) / screenHeight)
    }
}
