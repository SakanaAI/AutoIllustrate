export const HEADLESS_STDOUT_TAIL_BYTES = 8 * 1024 * 1024;

export function headlessStdoutLogPath(logPath: string): string {
  return `${logPath}.stdout`;
}
