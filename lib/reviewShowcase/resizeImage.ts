// 管理画面で選んだ写真を、送る前にブラウザで縮める(Server Action の受け取りの上限 1MB に収めるため)。
// 長辺 1600px 以内の JPEG にする。スマートフォンの写真(数MB)でも、ほとんどは 300〜700KB になる。
// ブラウザが読めない形式(古いブラウザの HEIC など)は null を返す(画面で別の写真を選んでもらう)。

const MAX_SIDE = 1600;
// 送る本文には写真のほかにフォームの項目も入るため、上限より少し小さくする。
export const RESIZED_IMAGE_TARGET_BYTES = 900 * 1024;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

export async function resizeShowcaseImage(file: Blob): Promise<Blob | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return null;
  }
  if (!img.naturalWidth || !img.naturalHeight) return null;

  for (const maxSide of [MAX_SIDE, 1200]) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 透過のある PNG も、黒ではなく白の背景にする。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65]) {
      const blob = await toJpeg(canvas, quality);
      if (blob && blob.size <= RESIZED_IMAGE_TARGET_BYTES) return blob;
    }
  }
  return null;
}
