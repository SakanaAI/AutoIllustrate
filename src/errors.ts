// Typed failure carrying the process exit code, thrown by phase modules and
// caught by the pipeline's failure surface (run.sh's ERR trap analogue).

export class PhaseError extends Error {
  readonly exitCode: number;
  readonly logPath?: string;

  constructor(message: string, exitCode = 1, logPath?: string) {
    super(message);
    this.name = "PhaseError";
    this.exitCode = exitCode;
    this.logPath = logPath;
  }
}
