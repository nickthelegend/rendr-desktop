// rendr-vision — on-device analysis of camera footage for creator edits.
//
//   rendr-vision analyze <input> --out <dir> [--matte] [--faces] [--max-edge 1280] [--quality fast|balanced|accurate]
//
// Writes, into <dir>:
//   matte.mp4   a greyscale H.264 video the same length as the input: white where a
//               person is, black where the background is. The editor uses it as a
//               mask to remove or replace the background ("green screen" without one).
//   faces.json  face boxes sampled through the video, normalized 0–1 with a
//               top-left origin, for face-following reframes and punch-in zooms.
//
// Everything runs through Apple's Vision framework on this Mac: no model to
// download, nothing leaves the machine. Progress is reported on stdout as one
// JSON object per line, ending with {"done":true,...} or {"error":"..."}.

import AVFoundation
import CoreImage
import Foundation
import Vision

struct Options {
	var input = ""
	var outDir = ""
	var matte = false
	var faces = false
	var maxEdge = 1280
	var quality: VNGeneratePersonSegmentationRequest.QualityLevel = .balanced
	/** Faces are sampled, not tracked per frame: heads move slowly and Vision is not free. */
	var faceInterval: Double = 0.2
	/**
	 * The matte is analysed at no more than this rate. A 60 fps phone clip gains
	 * nothing visible from a 60 fps mask, and it halves the time the analysis takes;
	 * the editor looks mattes up by time, so a lower rate lines up on its own.
	 */
	var matteFps: Double = 30
}

func emit(_ object: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: object),
	   let line = String(data: data, encoding: .utf8) {
		FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
	}
}

func fail(_ message: String) -> Never {
	emit(["error": message])
	exit(1)
}

func parse() -> Options {
	var options = Options()
	var args = Array(CommandLine.arguments.dropFirst())
	guard args.first == "analyze" else {
		fail("usage: rendr-vision analyze <input> --out <dir> [--matte] [--faces] [--max-edge N] [--quality fast|balanced|accurate]")
	}
	args.removeFirst()
	while !args.isEmpty {
		let arg = args.removeFirst()
		switch arg {
		case "--out": options.outDir = args.isEmpty ? "" : args.removeFirst()
		case "--matte": options.matte = true
		case "--faces": options.faces = true
		case "--max-edge": options.maxEdge = Int(args.isEmpty ? "" : args.removeFirst()) ?? 1280
		case "--matte-fps": options.matteFps = Double(args.isEmpty ? "" : args.removeFirst()) ?? 30
		case "--face-interval": options.faceInterval = Double(args.isEmpty ? "" : args.removeFirst()) ?? 0.2
		case "--quality":
			switch args.isEmpty ? "" : args.removeFirst() {
			case "fast": options.quality = .fast
			case "accurate": options.quality = .accurate
			default: options.quality = .balanced
			}
		default:
			if options.input.isEmpty { options.input = arg } else { fail("unexpected argument \(arg)") }
		}
	}
	if options.input.isEmpty || options.outDir.isEmpty { fail("input and --out are required") }
	if !options.matte && !options.faces { options.matte = true; options.faces = true }
	return options
}

/** Even dimensions no larger than maxEdge on the long side — H.264 needs even sizes. */
func outputSize(for natural: CGSize, maxEdge: Int) -> (Int, Int) {
	let long = max(natural.width, natural.height)
	let scale = long > CGFloat(maxEdge) ? CGFloat(maxEdge) / long : 1
	let w = Int((natural.width * scale / 2).rounded()) * 2
	let h = Int((natural.height * scale / 2).rounded()) * 2
	return (max(w, 2), max(h, 2))
}

func run() async {
	let options = parse()
	let url = URL(fileURLWithPath: options.input)
	let asset = AVURLAsset(url: url)
	guard let track = try? await asset.loadTracks(withMediaType: .video).first else {
		fail("no video track in \(options.input)")
	}
	let naturalSize = (try? await track.load(.naturalSize)) ?? .zero
	let transform = (try? await track.load(.preferredTransform)) ?? .identity
	let oriented = naturalSize.applying(transform)
	let displaySize = CGSize(width: abs(oriented.width), height: abs(oriented.height))
	let duration = (try? await asset.load(.duration))?.seconds ?? 0
	let nominalFps = Double((try? await track.load(.nominalFrameRate)) ?? 30)
	let fps = nominalFps > 0 ? nominalFps : 30

	try? FileManager.default.createDirectory(atPath: options.outDir, withIntermediateDirectories: true)

	guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read \(options.input)") }
	let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
		kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
	])
	output.alwaysCopiesSampleData = false
	reader.add(output)
	guard reader.startReading() else { fail(reader.error?.localizedDescription ?? "cannot start reading") }

	// Orientation: phone footage is often stored sideways with a rotation flag.
	let orientation = cgOrientation(for: transform)

	let (outW, outH) = outputSize(for: displaySize, maxEdge: options.maxEdge)
	var writer: AVAssetWriter?
	var writerInput: AVAssetWriterInput?
	var adaptor: AVAssetWriterInputPixelBufferAdaptor?
	let mattePath = (options.outDir as NSString).appendingPathComponent("matte.mp4")
	if options.matte {
		try? FileManager.default.removeItem(atPath: mattePath)
		guard let w = try? AVAssetWriter(outputURL: URL(fileURLWithPath: mattePath), fileType: .mp4) else {
			fail("cannot write \(mattePath)")
		}
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outW,
			AVVideoHeightKey: outH,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: max(outW * outH * 2, 1_000_000),
				AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
			],
		])
		input.expectsMediaDataInRealTime = false
		let pixelAdaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
			kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
			kCVPixelBufferWidthKey as String: outW,
			kCVPixelBufferHeightKey as String: outH,
		])
		w.add(input)
		guard w.startWriting() else { fail(w.error?.localizedDescription ?? "cannot start writing") }
		w.startSession(atSourceTime: .zero)
		writer = w
		writerInput = input
		adaptor = pixelAdaptor
	}

	let ciContext = CIContext(options: [.cacheIntermediates: false])
	let segmentation = VNGeneratePersonSegmentationRequest()
	segmentation.qualityLevel = options.quality
	segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
	let faceRequest = VNDetectFaceRectanglesRequest()

	var faceSamples: [[String: Any]] = []
	var nextFaceTime = 0.0
	var nextMatteTime = 0.0
	var previousMask: CIImage?
	var frames = 0
	var lastProgress = -1.0
	var personFrames = 0
	var matteFrames = 0

	while reader.status == .reading {
		guard let sample = output.copyNextSampleBuffer() else { break }
		guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
		let time = CMSampleBufferGetPresentationTimeStamp(sample)
		let seconds = time.seconds
		let wantsMatte = options.matte && seconds + 1e-6 >= nextMatteTime
		let wantsFaces = options.faces && seconds + 1e-6 >= nextFaceTime
		frames += 1
		if !wantsMatte && !wantsFaces { continue }
		let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: orientation, options: [:])
		var requests: [VNRequest] = []
		if wantsMatte {
			requests.append(segmentation)
			nextMatteTime = seconds + 1 / max(options.matteFps, 1)
		}
		if wantsFaces { requests.append(faceRequest) }
		do { try handler.perform(requests) } catch { continue }

		if wantsFaces {
			nextFaceTime = seconds + options.faceInterval
			let boxes: [[String: Double]] = (faceRequest.results ?? []).map { face in
				let box = face.boundingBox
				return [
					"x": Double(box.minX),
					// Vision's origin is bottom-left; everything else in Rendr is top-left.
					"y": Double(1 - box.maxY),
					"w": Double(box.width),
					"h": Double(box.height),
					"confidence": Double(face.confidence),
				]
			}
			faceSamples.append(["t": seconds, "faces": boxes])
		}

		if wantsMatte, let writerInput, let adaptor, let pool = adaptor.pixelBufferPool {
			var mask = CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
			if let result = segmentation.results?.first {
				let raw = CIImage(cvPixelBuffer: result.pixelBuffer)
				let scaled = raw.transformed(by: CGAffineTransform(
					scaleX: CGFloat(outW) / raw.extent.width,
					y: CGFloat(outH) / raw.extent.height
				))
				// A little temporal smoothing: Vision segments each frame alone, and
				// an edge that flickers frame to frame reads as cheap.
				if let previous = previousMask {
					mask = scaled.applyingFilter("CIDissolveTransition", parameters: [
						kCIInputTargetImageKey: previous,
						kCIInputTimeKey: 0.3,
					])
				} else {
					mask = scaled
				}
				previousMask = mask
				// A frame counts as "person in shot" when a meaningful share of the
				// mask is lit. Vision returns a mask for every frame, person or not.
				if maskCoverage(scaled, context: ciContext) > 0.02 { personFrames += 1 }
			}
			matteFrames += 1
			while !writerInput.isReadyForMoreMediaData { try? await Task.sleep(nanoseconds: 2_000_000) }
			var buffer: CVPixelBuffer?
			CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
			if let buffer {
				ciContext.render(mask.cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH)), to: buffer)
				adaptor.append(buffer, withPresentationTime: time)
			}
		}

		if duration > 0 {
			let progress = (seconds / duration * 100).rounded() / 100
			if progress - lastProgress >= 0.02 {
				lastProgress = progress
				emit(["progress": min(progress, 1)])
			}
		}
	}

	if reader.status == .failed { fail(reader.error?.localizedDescription ?? "reading failed") }

	if let writerInput, let writer {
		writerInput.markAsFinished()
		await writer.finishWriting()
		if writer.status != .completed { fail(writer.error?.localizedDescription ?? "writing the matte failed") }
	}

	var result: [String: Any] = [
		"done": true,
		"frames": frames,
		"fps": fps,
		"duration": duration,
		"width": Int(displaySize.width),
		"height": Int(displaySize.height),
	]
	if options.matte {
		result["matte"] = mattePath
		result["matteWidth"] = outW
		result["matteHeight"] = outH
		result["personFrames"] = personFrames
		result["matteFrames"] = matteFrames
	}
	if options.faces {
		let facesPath = (options.outDir as NSString).appendingPathComponent("faces.json")
		let document: [String: Any] = [
			"version": 1,
			"width": Int(displaySize.width),
			"height": Int(displaySize.height),
			"duration": duration,
			"interval": options.faceInterval,
			"samples": faceSamples,
		]
		if let data = try? JSONSerialization.data(withJSONObject: document) {
			FileManager.default.createFile(atPath: facesPath, contents: data)
		}
		result["faces"] = facesPath
		result["faceSamples"] = faceSamples.count
		result["framesWithFaces"] = faceSamples.filter { ($0["faces"] as? [Any])?.isEmpty == false }.count
	}
	emit(result)
}

/** Mean brightness of a mask, 0–1: the share of the frame Vision called "person". */
func maskCoverage(_ mask: CIImage, context: CIContext) -> Double {
	let extent = mask.extent
	guard let average = CIFilter(name: "CIAreaAverage", parameters: [
		kCIInputImageKey: mask,
		kCIInputExtentKey: CIVector(cgRect: extent),
	])?.outputImage else { return 0 }
	var pixel = [UInt8](repeating: 0, count: 4)
	context.render(average, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
	return Double(pixel[0]) / 255
}

/** Maps a track's preferred transform to the orientation Vision should read it in. */
func cgOrientation(for transform: CGAffineTransform) -> CGImagePropertyOrientation {
	switch (transform.a, transform.b, transform.c, transform.d) {
	case (0, 1, -1, 0): return .right
	case (0, -1, 1, 0): return .left
	case (-1, 0, 0, -1): return .down
	default: return .up
	}
}

let semaphore = DispatchSemaphore(value: 0)
Task {
	await run()
	semaphore.signal()
}
semaphore.wait()
