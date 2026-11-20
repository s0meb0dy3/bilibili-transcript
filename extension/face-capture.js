// 在侧栏本地检测人脸；只有均匀选出的少量画面会随检测结果返回。
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const CAPTURE_BATCH_SIZE = 12;
const vendorPath = file => new URL(`./vendor/mediapipe/${file}`, import.meta.url).href;
let detectorPromise;

function loadDetector() {
  detectorPromise ??= import('./vendor/mediapipe/vision_bundle.mjs').then(({ FaceDetector }) =>
    FaceDetector.createFromOptions({
      wasmLoaderPath: vendorPath('vision_wasm_internal.js'),
      wasmBinaryPath: vendorPath('vision_wasm_internal.wasm')
    }, {
      baseOptions: { modelAssetPath: vendorPath('blaze_face_short_range.tflite'), delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5
    })
  ).catch(error => {
    detectorPromise = undefined;
    throw error;
  });
  return detectorPromise;
}

async function decodeJpeg(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

const clamp = value => Math.min(1, Math.max(0, value));

function normalizeFaces(detections, { width, height }) {
  return detections.flatMap(({ boundingBox, categories }) => {
    if (!boundingBox) return [];
    const { originX, originY, width: w, height: h } = boundingBox;
    const x = clamp(originX / width);
    const y = clamp(originY / height);
    const right = clamp((originX + w) / width);
    const bottom = clamp((originY + h) / height);
    return right > x && bottom > y ? [{ box: [x, y, right - x, bottom - y], score: categories[0].score }] : [];
  });
}

export function createFaceCapture({ captureFrames, getDetector = loadDetector, decode = decodeJpeg }) {
  return async (times, signal) => {
    signal?.throwIfAborted();
    const samples = [...new Set(times.filter(time => Number.isFinite(time) && time >= 0))].sort((a, b) => a - b);
    if (!samples.length) return { frames: [] };
    const detector = await getDetector();
    const captured = new Map();
    for (let i = 0; i < samples.length; i += CAPTURE_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = await captureFrames(samples.slice(i, i + CAPTURE_BATCH_SIZE), signal);
      signal?.throwIfAborted();
      for (const { timeMs, dataUrl } of batch) {
        if (!Number.isFinite(timeMs) || timeMs < 0 || !dataUrl?.startsWith(JPEG_PREFIX) || captured.has(timeMs)) continue;
        const source = await decode(dataUrl);
        signal?.throwIfAborted();
        const faces = normalizeFaces(detector.detect(source).detections, source);
        captured.set(timeMs, { timeMs, faces, dataUrl });
      }
    }
    const ordered = [...captured.values()].sort((a, b) => a.timeMs - b.timeMs);
    const withFaces = ordered.filter(frame => frame.faces.length);
    const selected = new Set(withFaces.length <= 3
      ? withFaces
      : [withFaces[0], withFaces[Math.round((withFaces.length - 1) / 2)], withFaces.at(-1)]);
    return {
      frames: ordered.map(frame => ({
        timeMs: frame.timeMs, faces: frame.faces,
        ...(selected.has(frame) ? { image: frame.dataUrl.slice(JPEG_PREFIX.length) } : {})
      }))
    };
  };
}

export function expandedFaceBox([x, y, w, h], padding = 2.2) {
  const side = Math.min(1, Math.max(w, h) * padding);
  const centerX = x + w / 2;
  // 向下留一点肩膀空间，头像不会只剩一张大脸。
  const centerY = y + h / 2 + h * 0.15;
  const left = clamp(centerX - side / 2);
  const top = clamp(centerY - side / 2);
  return [clamp(left), clamp(top), Math.min(side, 1 - left), Math.min(side, 1 - top)];
}

export async function cropFaceImage(image, box) {
  const source = await decodeJpeg(JPEG_PREFIX + image);
  const [x, y, w, h] = expandedFaceBox(box);
  const left = Math.floor(x * source.width);
  const top = Math.floor(y * source.height);
  const width = Math.ceil((x + w) * source.width) - left;
  const height = Math.ceil((y + h) * source.height) - top;
  if (width <= 0 || height <= 0) throw new Error('无效的人脸区域');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, left, top, width, height, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.9).slice(JPEG_PREFIX.length);
}
