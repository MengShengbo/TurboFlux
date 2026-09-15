declare module 'qrcode/lib/browser.js' {
  interface SvgQrCodeOptions {
    errorCorrectionLevel: 'M'
    margin: number
    width: number
    type: 'svg'
  }

  const QRCode: {
    toString(text: string, options: SvgQrCodeOptions): Promise<string>
  }

  export default QRCode
}
