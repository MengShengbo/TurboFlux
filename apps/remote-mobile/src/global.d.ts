interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetector {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new(options?: { formats?: string[] }): BarcodeDetector
  getSupportedFormats?(): Promise<string[]>
}

interface Window {
  BarcodeDetector?: BarcodeDetectorConstructor
}
