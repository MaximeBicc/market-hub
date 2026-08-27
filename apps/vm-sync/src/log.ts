type Level = "debug" | "info" | "warn" | "error";

const ranks: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly minLevel = "info") {}

  private enabled(level: Level): boolean {
    const key = this.minLevel as Level;
    const min = ranks[key] ?? ranks.info;
    return ranks[level] >= min;
  }

  private write(level: Level, message: string, data?: unknown): void {
    if (!this.enabled(level)) return;
    const output = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      ...(data === undefined ? {} : { data }),
    });
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
  }

  debug(message: string, data?: unknown): void { this.write("debug", message, data); }
  info(message: string, data?: unknown): void { this.write("info", message, data); }
  warn(message: string, data?: unknown): void { this.write("warn", message, data); }
  error(message: string, data?: unknown): void { this.write("error", message, data); }
}
