import { File, FileCode, FileHtml, FileMd, FilePdf, FileText, Image } from "@phosphor-icons/react/ssr";
import type { FileKind } from "@/lib/file-mentions";

const PLAIN = /\.(txt|log|csv|tsv)$/i;

/** One monochrome icon per kind of file, so a chip says what opening it will show. */
export function FileIcon({ className, kind, name }: { className?: string; kind: FileKind; name?: string }) {
  const Icon = kind === "markdown" ? FileMd : kind === "html" ? FileHtml : kind === "image" ? Image : kind === "pdf" ? FilePdf
    : kind === "text" ? (name && PLAIN.test(name) ? FileText : FileCode) : File;
  return <Icon aria-hidden className={className} />;
}
