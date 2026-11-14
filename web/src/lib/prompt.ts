import { toast } from "sonner";

export interface PickedImage { url: string; data: string; mediaType: string }
export interface FirstPrompt { id: string; text: string; images: PickedImage[] }

/** Scale picked images to a 1600px long edge. PNG keeps its transparency. */
export async function readImage(file: File): Promise<PickedImage | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const mediaType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mediaType, 0.85);
    return { data: url.slice(url.indexOf(",") + 1), mediaType, url };
  } catch {
    toast.error(`讀不了 ${file.name}`);
    return null;
  }
}
