import CoreGraphics
import Foundation
import Vision

/// On-device OCR through Apple's Vision framework. No network, no cost.
public enum TextRecognizer {
    public static func lines(in image: CGImage) throws -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["de-DE", "en-US"]
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let observations = request.results ?? []
        // Reading order: top to bottom (Vision's origin is bottom-left), then left to right.
        let sorted = observations.sorted {
            let dy = $0.boundingBox.midY - $1.boundingBox.midY
            return abs(dy) > 0.01 ? dy > 0 : $0.boundingBox.minX < $1.boundingBox.minX
        }
        return sorted.compactMap { $0.topCandidates(1).first?.string }
    }
}
