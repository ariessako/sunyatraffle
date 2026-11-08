// Runs QR decoding off the main thread for browsers without BarcodeDetector (iPhones).
importScripts('vendor/jsQR.js');

let checkInverted = false;
self.onmessage = ({ data }) => {
  let code = null;
  try {
    // Every other frame also tries inverted codes (dark-mode tickets), which keeps most frames fast.
    // jsQR's 'onlyInvert' mode throws, so it can't be used for this.
    code = jsQR(data.pixels, data.width, data.height, {
      inversionAttempts: checkInverted ? 'attemptBoth' : 'dontInvert',
    });
  } catch {}
  checkInverted = !checkInverted;
  // Always reply: the scan loop waits for this message before sending the next frame.
  self.postMessage(code ? code.data : null);
};
