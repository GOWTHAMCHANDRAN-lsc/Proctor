// The optional document an exam's emails carry (exam editor → Emails → Attachment). The limits and
// file types here mirror api/exam_attachments.php, which enforces them again on upload.

/** 5 MB: every recipient's email carries the file. */
export const EXAM_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export const EXAM_ATTACHMENT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'png', 'jpg', 'jpeg',
] as const;

/** Value for a file input's `accept`. */
export const EXAM_ATTACHMENT_ACCEPT = EXAM_ATTACHMENT_EXTENSIONS.map(ext => `.${ext}`).join(',');

/** "1.2 MB", "340 KB", "512 bytes". */
export const formatFileSize = (bytes: number): string => {
  const size = Math.max(0, Number(bytes) || 0);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} byte${size === 1 ? '' : 's'}`;
};

/** Why this file cannot be attached, or null when it can. */
export const validateExamAttachment = (file: File): string | null => {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!(EXAM_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return 'This type of file cannot be attached. Use a PDF, Word, Excel, PowerPoint, text, CSV, PNG or JPG file.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > EXAM_ATTACHMENT_MAX_BYTES) {
    return `The file is ${formatFileSize(file.size)}. Every email carries it, so the limit is 5 MB.`;
  }
  return null;
};

/** The file's bytes as base64 (no "data:" prefix), which is how the upload travels. */
export const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('The file could not be read from your computer.'));
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const comma = result.indexOf(',');
    resolve(comma >= 0 ? result.slice(comma + 1) : '');
  };
  reader.readAsDataURL(file);
});
