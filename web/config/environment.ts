import { existsSync, readFileSync } from "node:fs";

export function parseSettings(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 0 || !/^SCREEN_CONTROL_[A-Z0-9_]+$/.test(key)) {
      throw new Error(`invalid environment key on line ${index + 1}`);
    }
    let value = line.slice(separator + 1).trim();
    if (value.startsWith("'") || value.startsWith('"')) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`unclosed quote on line ${index + 1}`);
      value = value.slice(1, -1);
    } else if (/\s/.test(value)) {
      throw new Error(`quote values containing whitespace on line ${index + 1}`);
    }
    if (value.includes("\0")) throw new Error(`invalid value on line ${index + 1}`);
    values[key] = value;
  }
  return values;
}

export function readSettings(environment: NodeJS.ProcessEnv, defaultPath: string): Record<string, string | undefined> {
  const explicit = environment.SCREEN_CONTROL_ENV_FILE;
  const path = explicit || defaultPath;
  const values = explicit || existsSync(path) ? parseSettings(readFileSync(path, "utf8")) : {};
  return { ...values, ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("SCREEN_CONTROL_"))) };
}
