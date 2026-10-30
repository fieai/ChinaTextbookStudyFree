import Foundation
import PDFKit
import Vision
import AppKit

// Offline OCR. Preserve coordinates and confidence so editorial extraction can
// distinguish body text from pinyin, side notes, exercises and page numbers.
let args = CommandLine.arguments
guard args.count >= 3, let document = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    fatalError("Usage: ocr PDF OUTPUT_DIRECTORY [FIRST_PAGE] [LAST_PAGE]")
}
let output = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let first = args.count > 3 ? Int(args[3])! : 1
let last = args.count > 4 ? Int(args[4])! : document.pageCount
for number in first...last {
    let target = output.appendingPathComponent(String(format: "p%03d.json", number))
    if FileManager.default.fileExists(atPath: target.path) { continue }
    try autoreleasepool {
        guard let page = document.page(at: number - 1) else { return }
        let size = page.bounds(for: .mediaBox).size
        let image = page.thumbnail(of: NSSize(width: size.width * 3, height: size.height * 3), for: .mediaBox)
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: cgImage).perform([request])
        let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return ["text": candidate.string, "confidence": candidate.confidence,
                    "x": box.minX, "y": 1 - box.maxY, "width": box.width, "height": box.height]
        }
        let result: [String: Any] = ["pdfPage": number, "width": size.width,
                                    "height": size.height, "engine": "Apple Vision accurate zh-Hans",
                                    "lines": lines]
        let bytes = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try bytes.write(to: target, options: .atomic)
        print("OCR \(number)/\(document.pageCount): \(lines.count) lines")
    }
}
