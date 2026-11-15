// Sends a file into the session's folder (.imnotcc/uploads/), with progress, and answers with
// the path Claude can read it at.
import { auth } from "./api";

/** `relative` is from the session's folder, where Claude runs. */
export interface Uploaded { path: string; relative: string; name: string; size: number }

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function uploadFile(session: string, file: File, onProgress?: (pct: number) => void): Promise<Uploaded> {
  if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new Error(`${file.name} 太大，上限是 50 MB。`));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/sessions/${encodeURIComponent(session)}/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: Partial<Uploaded> & { error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 401 && data.error === "login") auth.set({ authed: false });
      if (xhr.status >= 200 && xhr.status < 300 && data.path) resolve(data as Uploaded);
      else reject(new Error(data.error || `上傳失敗（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error("上傳失敗，連線中斷了。"));
    xhr.send(file);
  });
}

/** The line added to the message for an uploaded file. */
export const attachmentLine = (path: string) => `附件：\`${path}\``;
